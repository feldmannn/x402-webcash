// Example: an Express resource server that paywalls /premium with webcash via x402.
// Run with: npm run example
// Requires the facilitator to be running (npm run facilitator).
//
// Persistence in this example is a tiny in-memory wallet — replace `appendSecret`
// with a real wallet (database, hrmw CLI handoff, encrypted file, etc.) before
// trusting it with non-toy amounts.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import express from "express";
import { paywall, type WebcashOutput } from "../src/middleware.js";

const PORT = Number(process.env.PORT ?? 4020);
const FACILITATOR = process.env.FACILITATOR_URL ?? "http://localhost:4021";
const WALLET_FILE = resolve(process.env.WALLET_FILE ?? "./wallet.jsonl");

mkdirSync(dirname(WALLET_FILE), { recursive: true });

function appendSecret(output: WebcashOutput): void {
  appendFileSync(
    WALLET_FILE,
    JSON.stringify({ ...output, receivedAt: new Date().toISOString() }) + "\n",
    { encoding: "utf8" },
  );
}

const app = express();

app.get("/", (_req, res) => {
  res.json({
    message: "x402-webcash example resource server",
    endpoints: { paid: "/premium" },
    walletFile: WALLET_FILE,
  });
});

app.get(
  "/premium",
  paywall({
    amountWats: 30_000_000n, // 0.3 webcash
    facilitatorUrl: FACILITATOR,
    description: "Premium endpoint paid in webcash",
    mimeType: "application/json",
    onSettled: (output) => appendSecret(output),
  }),
  (_req, res) => {
    res.json({ secret: "the answer is 42" });
  },
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `example resource server listening on :${PORT} (facilitator=${FACILITATOR}, wallet=${WALLET_FILE})`,
  );
});
