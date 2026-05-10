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
  maxTimeoutSeconds?: number;
  resourceUrl?: (req: Request) => string;
  fetchImpl?: typeof fetch;
  /**
   * Called after a successful settlement with the newly-minted output secret.
   * If you do not persist this secret to a wallet, the funds are lost.
   * Omit only for testing.
   */
  onSettled?: (output: WebcashOutput, req: Request) => void | Promise<void>;
};

const HTTPS_OR_LOOPBACK = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$))/i;

export function paywall(opts: PaywallOptions): RequestHandler {
  const network = opts.network ?? "webcash:mainnet";
  const payTo = opts.payTo ?? "https://webcash.org";
  const facilitatorUrl = (opts.facilitatorUrl ?? "http://localhost:4021").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const amount = String(opts.amountWats);

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
      maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
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

    let settled: SettlementResponse;
    try {
      const r = await fetchImpl(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settleReq),
      });
      settled = (await r.json()) as SettlementResponse;
    } catch (e) {
      respond402(res, `facilitator unreachable: ${(e as Error).message}`, resource, requirements);
      return;
    }

    if (!settled.success) {
      respond402(res, settled.errorReason ?? "settlement_failed", resource, requirements);
      return;
    }

    const output = (settled.extensions as { webcashOutput?: WebcashOutput } | undefined)?.webcashOutput;
    if (output && opts.onSettled) {
      try {
        await opts.onSettled(output, req);
      } catch (e) {
        // The funds have already moved at the issuer. We must not silently
        // succeed the request without persisting the secret — the caller's
        // persistence layer just failed and they need to know.
        respond402(
          res,
          `output_persistence_failed: ${(e as Error).message}`,
          resource,
          requirements,
        );
        return;
      }
    }

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settled), "utf8").toString("base64"));
    next();
  };
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
