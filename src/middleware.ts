// Drop-in Express middleware: turn any route into a webcash-paywalled endpoint.
// Talks to a separate facilitator service (default http://localhost:4021).

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type {
  FacilitatorRequest,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SettlementResponse,
  WebcashPayload,
} from "./types.js";

export type WebcashOutput = {
  secret: string;
  amountDecimal: string;
  amountWats: string;
};

export type PaywallOptions = {
  amountWats: bigint | number | string;
  network?: string;
  payTo?: string;
  facilitatorUrl?: string;
  description?: string;
  mimeType?: string;
  /** Wall-clock budget for the facilitator round-trip, in seconds. Default 60. */
  maxTimeoutSeconds?: number;
  resourceUrl?: (req: Request) => string;
  /**
   * Scheme-specific extra fields propagated into `paymentRequirements.extra`.
   * Use for `extra.issuerUrl` to settle against a custom webcash issuer
   * (the URL must also be on the facilitator's allowlist).
   */
  extra?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  /**
   * Called after a successful settlement with the newly-minted output secret.
   * If you do not persist this secret to a wallet, the funds are lost. If
   * this throws, `onSettledRecovery` is invoked and the request fails 500
   * (the funds have already moved at the issuer; do not return 402).
   */
  onSettled?: (output: WebcashOutput, req: Request) => void | Promise<void>;
  /**
   * Last-resort sink invoked when `onSettled` throws. Receives the same
   * output secret plus the original error. Use this to write to a recovery
   * channel that is independent of your primary persistence (different disk,
   * different DB, off-host log, etc.). If THIS also throws, the secret is
   * logged to stderr as the absolute last witness — operators must grep for
   * "[x402-webcash][CRITICAL]" to recover.
   */
  onSettledRecovery?: (
    output: WebcashOutput,
    originalError: unknown,
    req: Request,
  ) => void | Promise<void>;
};

const HTTPS_OR_LOOPBACK = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$))/i;

export function paywall(opts: PaywallOptions): RequestHandler {
  const network = opts.network ?? "webcash:mainnet";
  const payTo = opts.payTo ?? "https://webcash.org";
  const facilitatorUrl = (opts.facilitatorUrl ?? "http://localhost:4021").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const amount = String(opts.amountWats);
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 60;
  const fetchTimeoutMs = maxTimeoutSeconds * 1000;

  if (!HTTPS_OR_LOOPBACK.test(facilitatorUrl)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[x402-webcash] facilitatorUrl "${facilitatorUrl}" is neither HTTPS nor loopback. ` +
        `Webcash secrets will transit in plaintext and can be stolen by any network observer.`,
    );
  }
  if (!opts.onSettled) {
    // eslint-disable-next-line no-console
    console.warn(
      `[x402-webcash] paywall has no onSettled callback configured. ` +
        `Output webcash secrets will not be persisted; settled funds will be lost.`,
    );
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    const requirements: PaymentRequirements = {
      scheme: "webcash",
      network,
      amount,
      asset: "webcash",
      payTo,
      maxTimeoutSeconds,
      ...(opts.extra ? { extra: opts.extra } : {}),
    };

    const resource: ResourceInfo = {
      url: opts.resourceUrl ? opts.resourceUrl(req) : `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
    };

    const header = req.header("X-PAYMENT") ?? req.header("x-payment");
    if (!header) {
      respond402(res, "X-PAYMENT header is required", resource, requirements);
      return;
    }

    let payload: PaymentPayload<WebcashPayload>;
    try {
      const json = Buffer.from(header, "base64").toString("utf8");
      payload = JSON.parse(json);
    } catch {
      respond402(res, "X-PAYMENT must be base64-encoded JSON", resource, requirements);
      return;
    }

    const settleReq: FacilitatorRequest = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };

    let facResponse: globalThis.Response;
    try {
      facResponse = await fetchImpl(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settleReq),
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const detail = (e as Error).name === "TimeoutError" || msg.toLowerCase().includes("timeout")
        ? `facilitator timed out after ${maxTimeoutSeconds}s`
        : `facilitator unreachable: ${msg}`;
      respond402(res, detail, resource, requirements);
      return;
    }

    if (!facResponse.ok && facResponse.status !== 402) {
      // Treat any non-2xx (other than 402) as a facilitator failure. We must
      // assume the secret was NOT spent — the client can safely retry.
      respond402(
        res,
        `facilitator returned HTTP ${facResponse.status}`,
        resource,
        requirements,
      );
      return;
    }

    let settled: SettlementResponse;
    try {
      settled = (await facResponse.json()) as SettlementResponse;
    } catch {
      respond402(res, "facilitator response was not JSON", resource, requirements);
      return;
    }

    if (!settled.success) {
      respond402(res, settled.errorReason ?? "settlement_failed", resource, requirements);
      return;
    }

    const output = (settled.extensions as { webcashOutput?: WebcashOutput } | undefined)?.webcashOutput;

    // Integrity gate: a successful settlement MUST carry the output secret.
    // A facilitator that returns success without it has either lost the secret
    // or stolen it; either way the resource server has not been paid and MUST
    // NOT serve the resource.
    if (!isValidOutput(output)) {
      // eslint-disable-next-line no-console
      console.error(
        `[x402-webcash][CRITICAL] missing_or_malformed_output_secret ` +
          `transaction=${settled.transaction} network=${settled.network} ` +
          `facilitator=${facilitatorUrl}. The facilitator returned success but ` +
          `did not surface the new bearer token. Funds may have been settled at ` +
          `the issuer without the resource server receiving them — investigate ` +
          `the facilitator immediately.`,
      );
      respond500(
        res,
        "settlement_integrity_failure",
        `facilitator returned success without extensions.webcashOutput. The funds ` +
          `may have been replaced at the issuer without persistence on this server. ` +
          `Audit the facilitator at ${facilitatorUrl}.`,
        settled.transaction,
      );
      return;
    }

    if (opts.onSettled) {
      try {
        await opts.onSettled(output, req);
      } catch (primaryErr) {
        // The funds have already moved at the issuer. We MUST NOT silently
        // succeed without recording the new secret somewhere durable.
        // Order of attempts: caller's recovery sink → stderr (last resort).
        await runRecovery(output, primaryErr, req, opts.onSettledRecovery);
        respond500(
          res,
          "output_persistence_failed",
          `primary persistence threw; recovery hook fired. Search logs for "[x402-webcash][CRITICAL]" with this transaction id to retrieve the secret.`,
          settled.transaction,
        );
        return;
      }
    }

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settled), "utf8").toString("base64"));
    next();
  };
}

function isValidOutput(o: unknown): o is WebcashOutput {
  if (!o || typeof o !== "object") return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x.secret === "string" &&
    x.secret.length > 0 &&
    typeof x.amountDecimal === "string" &&
    typeof x.amountWats === "string"
  );
}

async function runRecovery(
  output: WebcashOutput,
  originalError: unknown,
  req: Request,
  recovery: PaywallOptions["onSettledRecovery"],
): Promise<void> {
  // Always emit to stderr first — that's the durable witness even if the
  // recovery callback also throws. Operators can grep for the marker.
  // eslint-disable-next-line no-console
  console.error(
    `[x402-webcash][CRITICAL] persistence_failure secret=${output.secret} ` +
      `amountWats=${output.amountWats} amountDecimal=${output.amountDecimal} ` +
      `error=${(originalError as Error)?.message ?? String(originalError)}`,
  );
  if (!recovery) return;
  try {
    await recovery(output, originalError, req);
  } catch (recoveryErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[x402-webcash][CRITICAL] recovery_callback_also_failed secret=${output.secret} ` +
        `recoveryError=${(recoveryErr as Error)?.message ?? String(recoveryErr)}`,
    );
  }
}

function respond402(
  res: Response,
  error: string,
  resource: ResourceInfo,
  requirements: PaymentRequirements,
): void {
  const body: PaymentRequired = {
    x402Version: 2,
    error,
    resource,
    accepts: [requirements],
  };
  res.status(402).json(body);
}

function respond500(res: Response, error: string, detail: string, transaction: string): void {
  // 500 — not 402 — because settlement DID happen at the issuer and a retry
  // by the client cannot help (the input secret is already spent).
  res.status(500).json({
    error,
    detail,
    transaction,
  });
}
