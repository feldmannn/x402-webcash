// Example: an Express resource server that paywalls /premium with webcash via x402.
// Run with: npm run example
// Requires the facilitator to be running (npm run facilitator).

import express from "express";
import { paywall } from "../src/middleware.js";

const PORT = Number(process.env.PORT ?? 4020);
const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4021";

const app = express();

app.get("/", (_req, res) => {
  res.json({
    message: "x402-webcash example resource server",
    endpoints: { paid: "/premium" },
  });
});

app.get(
  "/premium",
  paywall({
    amountWats: 30_000_000n, // 0.3 webcash
    facilitatorUrl: FACILITATOR,
    description: "Premium endpoint paid in webcash",
    mimeType: "application/json",
  }),
  (_req, res) => {
    res.json({ secret: "the answer is 42" });
  },
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`example resource server listening on :${PORT} (facilitator=${FACILITATOR})`);
});
