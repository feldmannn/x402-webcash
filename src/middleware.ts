// Drop-in Express middleware: turn any route into a webcash-paywalled endpoint.
//
// Two flavors are exported:
//
//   paywall(opts)              — talks to a separate facilitator service over
//                                HTTPS. The standard deployment.
//   paywallLocal(facilitator, opts) — calls a Facilitator instance directly,
//                                no HTTP hop. Use when the resource server
//                                runs the facilitator in-process; eliminates
//                                the third-party trust boundary entirely.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Facilitator, isAcceptableIssuerScheme } from "./facilitator.js";
import { createPinnedFetch } from "./pinning.js";
import { RecipientKey } from "./recipient.js";
import { watsToDecimal } from "./webcash.js";
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

/**
 * Shared options between `paywall` and `paywallLocal`. Everything except how
 * the facilitator is reached lives here.
 */
type BasePaywallOptions = {
  amountWats: bigint | number | string;
  network?: string;
  payTo?: string;
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
  /**
   * Recipient key for buyer-derived output binding. When set:
   *
   *   1. Every 402 challenge includes `extra.recipientPublicKey` (raw X25519,
   *      base64) and `extra.recipientNonce` (random per-request).
   *   2. Buyers MUST supply a derived output secret + buyerPublicKey in the
   *      payment payload, and the facilitator MUST honor it (see
   *      src/recipient.ts and specs/scheme_webcash.md).
   *   3. After a successful settlement, the returned `webcashOutput.secret`
   *      is re-derived against `recipientKey + buyerPublicKey + nonce +
   *      amount` and verified. A mismatch surfaces as 500 with a CRITICAL
   *      log — strong evidence the facilitator substituted an output.
   *
   * Closes the third-party-facilitator trust hole (the facilitator no
   * longer chooses the output secret). Residual race-window risk remains;
   * see the spec for details.
   */
  recipientKey?: RecipientKey;
};

export type PaywallOptions = BasePaywallOptions & {
  facilitatorUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Permit non-HTTPS facilitator URLs that aren't loopback. Defaults to
   * false: misconfigured facilitator URLs throw at construction time
   * instead of silently transmitting bearer secrets over plaintext. Set
   * true only for test rigs.
   */
  allowHttpFacilitator?: boolean;
  /**
   * SPKI pins for the facilitator's TLS cert. When set, the paywall's call
   * to `${facilitatorUrl}/settle` performs the standard CA/hostname check
   * AND requires the server's SPKI hash to match one of these pins. A
   * mismatch makes the request fail at the TLS layer with a
   * `PinMismatchError`; the request body (the buyer's secret) is never
   * transmitted. Mutually exclusive with `fetchImpl`.
   */
  pinnedSpkiHashes?: readonly string[];
};

/**
 * Options for `paywallLocal`. Same as `PaywallOptions` minus the HTTP-only
 * fields, since paywallLocal never makes a network call to a facilitator.
 */
export type PaywallLocalOptions = BasePaywallOptions;

/**
 * Internal result of a settle attempt. `ok` carries the SettlementResponse
 * (which itself may indicate success or failure at the protocol level).
 * `retriable` is reserved for transport-layer failures that left the input
 * untouched — only the HTTP-backed paywall produces this.
 */
type SettleAttempt =
  | { kind: "ok"; settled: SettlementResponse }
  | { kind: "retriable"; detail: string };

type SettleFn = (req: FacilitatorRequest) => Promise<SettleAttempt>;

// ---------------------------------------------------------------------------
// HTTP-backed paywall
// ---------------------------------------------------------------------------

export function paywall(opts: PaywallOptions): RequestHandler {
  const facilitatorUrl = (opts.facilitatorUrl ?? "http://localhost:4021").replace(/\/$/, "");
  if (opts.pinnedSpkiHashes?.length && opts.fetchImpl) {
    throw new Error(
      `[x402-webcash] paywall: pinnedSpkiHashes and fetchImpl are mutually ` +
        `exclusive — pinning operates at the TLS dispatcher layer, so a ` +
        `caller-supplied fetchImpl would either bypass it or double-wrap it.`,
    );
  }
  const fetchImpl = opts.pinnedSpkiHashes?.length
    ? createPinnedFetch({ pinnedSpkiHashes: opts.pinnedSpkiHashes })
    : (opts.fetchImpl ?? fetch);
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 60;
  const fetchTimeoutMs = maxTimeoutSeconds * 1000;

  if (!isAcceptableIssuerScheme(facilitatorUrl, opts.allowHttpFacilitator ?? false)) {
    throw new Error(
      `[x402-webcash] facilitatorUrl "${facilitatorUrl}" is neither HTTPS nor loopback. ` +
        `Refusing to install paywall — webcash secrets would transit in plaintext ` +
        `from the resource server to the facilitator and could be stolen by any ` +
        `on-path observer. Pass allowHttpFacilitator:true to override (test rigs only).`,
    );
  }

  const settleFn: SettleFn = async (settleReq) => {
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
      return { kind: "retriable", detail };
    }
    if (!facResponse.ok && facResponse.status !== 402) {
      // Treat any non-2xx (other than 402) as a facilitator failure. The
      // secret was NOT spent — the client can safely retry.
      return { kind: "retriable", detail: `facilitator returned HTTP ${facResponse.status}` };
    }
    let settled: SettlementResponse;
    try {
      settled = (await facResponse.json()) as SettlementResponse;
    } catch {
      return { kind: "retriable", detail: "facilitator response was not JSON" };
    }
    return { kind: "ok", settled };
  };

  return buildHandler(opts, settleFn, { facilitatorContext: facilitatorUrl });
}

// ---------------------------------------------------------------------------
// In-process paywall — no HTTP hop, no trust boundary.
// ---------------------------------------------------------------------------

/**
 * Paywall an Express route by calling a `Facilitator` instance directly.
 *
 * Use this when the resource server runs the facilitator in-process. This
 * eliminates the entire facilitator-trust concern: there is no third party
 * to MITM, mis-issue, or substitute outputs, and combined with a
 * caller-supplied `mintOutputSecret` on the Facilitator, the resource
 * server controls every step of settlement.
 *
 * Semantics match `paywall`:
 *   - non-success SettlementResponse  → 402 with errorReason
 *   - success without webcashOutput   → 500 (integrity gate)
 *   - onSettled throws                → 500 + recovery hook + CRITICAL log
 *   - happy path                      → next() with X-PAYMENT-RESPONSE
 *
 * Because there is no network, the "facilitator unreachable" / "non-2xx"
 * / "non-JSON" failure modes that produce 402 in `paywall` do not exist
 * here. Any throw from `facilitator.settle()` itself (which is not
 * supposed to throw — it returns a SettlementResponse for every input)
 * surfaces as 500 `unexpected_facilitator_throw`.
 */
export function paywallLocal(
  facilitator: Facilitator,
  opts: PaywallLocalOptions,
): RequestHandler {
  const settleFn: SettleFn = async (settleReq) => {
    let settled: SettlementResponse;
    try {
      settled = await facilitator.settle(settleReq);
    } catch (e) {
      // Defensive: facilitator.settle() is designed never to throw. If it
      // does, the input has NOT been transmitted to the issuer (the throw
      // happened before /replace), so the client can safely retry. Surface
      // as retriable.
      const msg = (e as Error).message ?? String(e);
      return { kind: "retriable", detail: `unexpected_facilitator_throw: ${msg}` };
    }
    return { kind: "ok", settled };
  };
  return buildHandler(opts, settleFn, { facilitatorContext: "in-process" });
}

// ---------------------------------------------------------------------------
// Shared handler logic — everything except how settlement is performed.
// ---------------------------------------------------------------------------

function buildHandler(
  opts: BasePaywallOptions,
  settleFn: SettleFn,
  context: { facilitatorContext: string },
): RequestHandler {
  const network = opts.network ?? "webcash:mainnet";
  const payTo = opts.payTo ?? "https://webcash.org";
  const amount = String(opts.amountWats);
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 60;

  if (!opts.onSettled) {
    // eslint-disable-next-line no-console
    console.warn(
      `[x402-webcash] paywall has no onSettled callback configured. ` +
        `Output webcash secrets will not be persisted; settled funds will be lost.`,
    );
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // Per-request recipient binding state: fresh nonce per challenge so two
    // requests against the same paywall cannot share an output secret.
    const recipientNonce = opts.recipientKey ? RecipientKey.newNonce() : undefined;
    const bindingExtra: Record<string, unknown> = opts.recipientKey
      ? {
          recipientPublicKey: opts.recipientKey.publicKeyBase64,
          recipientNonce,
        }
      : {};

    const requirements: PaymentRequirements = {
      scheme: "webcash",
      network,
      amount,
      asset: "webcash",
      payTo,
      maxTimeoutSeconds,
      ...((opts.extra || Object.keys(bindingExtra).length > 0)
        ? { extra: { ...(opts.extra ?? {}), ...bindingExtra } }
        : {}),
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

    const attempt = await settleFn(settleReq);
    if (attempt.kind === "retriable") {
      respond402(res, attempt.detail, resource, requirements);
      return;
    }
    const settled = attempt.settled;

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
          `facilitator=${context.facilitatorContext}. The facilitator returned ` +
          `success but did not surface the new bearer token. Funds may have ` +
          `been settled at the issuer without the resource server receiving ` +
          `them — investigate the facilitator immediately.`,
      );
      respond500(
        res,
        "settlement_integrity_failure",
        `facilitator returned success without extensions.webcashOutput. The funds ` +
          `may have been replaced at the issuer without persistence on this server. ` +
          `Audit the facilitator (${context.facilitatorContext}).`,
        settled.transaction,
      );
      return;
    }

    // Recipient-binding verification: if we published a binding challenge,
    // re-derive the expected output from our private key + buyer's pubkey +
    // nonce + amount and compare against what the facilitator returned. A
    // mismatch means the facilitator did not honor the binding (substituted
    // a different output) — the funds may have settled at the issuer but
    // they're NOT going to the resource server's wallet.
    //
    // The nonce we verify against is the ECHOED nonce from the buyer's
    // payload — not the per-request nonce regenerated here. The probe/retry
    // are two distinct requests, so the per-request nonce only matters as
    // an upper bound on what the 402 advertised; the buyer commits to the
    // value they actually received, and that's what we verify.
    if (opts.recipientKey) {
      const acceptedExtra = (payload.accepted.extra ?? {}) as Record<string, unknown>;
      const echoedNonce = acceptedExtra["recipientNonce"];
      const buyerPublicKey =
        (payload.payload as { buyerPublicKey?: unknown }).buyerPublicKey;
      if (typeof echoedNonce !== "string" || echoedNonce.length === 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[x402-webcash][CRITICAL] binding_nonce_missing ` +
            `transaction=${settled.transaction} secret=${output.secret}. ` +
            `Server advertised recipient binding but payload.accepted.extra` +
            `.recipientNonce was absent — cannot verify the returned output.`,
        );
        respond500(
          res,
          "binding_verification_failure",
          "server advertised recipient binding but the buyer did not echo a recipientNonce",
          settled.transaction,
        );
        return;
      }
      if (typeof buyerPublicKey !== "string" || buyerPublicKey.length === 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[x402-webcash][CRITICAL] binding_buyerPublicKey_missing ` +
            `transaction=${settled.transaction} secret=${output.secret}. ` +
            `Server advertised recipient binding but payload.buyerPublicKey ` +
            `was absent — cannot verify the returned output. Funds may have ` +
            `settled at the issuer; investigate the facilitator.`,
        );
        respond500(
          res,
          "binding_verification_failure",
          "server advertised recipient binding but the buyer did not echo a buyerPublicKey",
          settled.transaction,
        );
        return;
      }
      // Use OUR canonical decimal — not output.amountDecimal — because a
      // dishonest facilitator could ship a wrong amountDecimal label to make
      // the verification pass for a different amount.
      const canonicalDecimal = watsToDecimal(BigInt(amount));
      let verified = false;
      try {
        verified = opts.recipientKey.verifyOutputSecret(
          buyerPublicKey,
          echoedNonce,
          canonicalDecimal,
          output.secret,
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[x402-webcash][CRITICAL] binding_verification_threw ` +
            `transaction=${settled.transaction} secret=${output.secret} ` +
            `error=${(e as Error).message ?? String(e)}. Cannot verify ` +
            `binding; treating as substituted.`,
        );
      }
      if (!verified) {
        // eslint-disable-next-line no-console
        console.error(
          `[x402-webcash][CRITICAL] binding_mismatch_facilitator_substituted_output ` +
            `transaction=${settled.transaction} returned_secret=${output.secret} ` +
            `context=${context.facilitatorContext}. The facilitator returned ` +
            `an output secret that does NOT match the buyer-derived value the ` +
            `paywall is expecting. This is strong evidence of facilitator ` +
            `substitution — the funds at the issuer are NOT going to this ` +
            `resource server. Stop using this facilitator immediately.`,
        );
        respond500(
          res,
          "binding_verification_failure",
          "the facilitator-returned output secret does not match the buyer-derived value — facilitator substitution detected",
          settled.transaction,
        );
        return;
      }
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
  recovery: BasePaywallOptions["onSettledRecovery"],
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
