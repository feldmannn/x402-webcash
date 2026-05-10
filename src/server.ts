// Standalone HTTP facilitator server. Implements the x402 v2 facilitator API
// for the `webcash` scheme: POST /verify, POST /settle, GET /supported.

import express from "express";
import { Facilitator } from "./facilitator.js";
import type { FacilitatorRequest } from "./types.js";

const PORT = Number(process.env.PORT ?? 4021);
const issuerAllowlist = (process.env.WEBCASH_ISSUER_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const facilitator = new Facilitator({ issuerAllowlist });
const app = express();
app.use(express.json({ limit: "64kb" }));

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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`x402-webcash facilitator listening on :${PORT}`);
});
