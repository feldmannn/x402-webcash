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
};

export function paywall(opts: PaywallOptions): RequestHandler {
  const network = opts.network ?? "webcash:mainnet";
  const payTo = opts.payTo ?? "https://webcash.org";
  const facilitatorUrl = (opts.facilitatorUrl ?? "http://localhost:4021").replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const amount = String(opts.amountWats);

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
