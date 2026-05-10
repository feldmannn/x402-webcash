// Standalone HTTP facilitator server. Implements the x402 v2 facilitator API
// for the `webcash` scheme: POST /verify, POST /settle, GET /supported.

import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { Facilitator } from "./facilitator.js";
import type { FacilitatorRequest } from "./types.js";

const PORT = Number(process.env.PORT ?? 4021);
const issuerAllowlist = (process.env.WEBCASH_ISSUER_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";

const facilitator = new Facilitator({ issuerAllowlist });
const app = express();
app.use(express.json({ limit: "64kb" }));

// Permissive CORS so browser-based x402 clients can reach the facilitator.
// Override the origin via CORS_ORIGIN env var; set to a specific origin in
// production rather than "*".
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-payment");
  res.setHeader("Access-Control-Expose-Headers", "x-payment-response");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/supported", (_req, res) => {
  res.json(facilitator.supported());
});

app.post("/verify", async (req, res) => {
  const body = req.body as FacilitatorRequest;
  if (!validBody(body)) {
    res.status(400).json({ isValid: false, invalidReason: "invalid_payload" });
    return;
  }
  res.json(await facilitator.verify(body));
});

app.post("/settle", async (req, res) => {
  const body = req.body as FacilitatorRequest;
  if (!validBody(body)) {
    const network = (req.body as { paymentRequirements?: { network?: string } } | undefined)
      ?.paymentRequirements?.network ?? "";
    res.status(400).json({
      success: false,
      errorReason: "invalid_payload",
      transaction: "",
      network,
    });
    return;
  }
  res.json(await facilitator.settle(body));
});

function validBody(body: unknown): body is FacilitatorRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.x402Version === 2 && !!b.paymentPayload && !!b.paymentRequirements;
}

// Catch-all error handler so a thrown handler returns structured JSON
// instead of Express's default HTML stack-trace page.
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error(`[x402-webcash] handler error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  if (req.path === "/verify") {
    res.status(500).json({ isValid: false, invalidReason: "unexpected_verify_error" });
    return;
  }
  if (req.path === "/settle") {
    const network = (req.body as { paymentRequirements?: { network?: string } } | undefined)
      ?.paymentRequirements?.network ?? "";
    res.status(500).json({
      success: false,
      errorReason: "unexpected_settle_error",
      transaction: "",
      network,
    });
    return;
  }
  res.status(500).json({ error: "internal_error" });
};
app.use(errorHandler);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`x402-webcash facilitator listening on :${PORT}`);
});
