// Opt-in integration test against a real webcash issuer.
// Run with: E2E=1 WEBCASH_INPUT_SECRET=<spendable> node --test --import tsx tests/e2e.test.ts
//
// The test will SPEND the input secret (replacing it with a fresh random one).
// Only run with a small disposable secret you own.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Facilitator } from "../src/facilitator.js";
import { issuerHealth, parseSecret } from "../src/webcash.js";
import type { FacilitatorRequest } from "../src/types.js";

const enabled = process.env.E2E === "1";
const inputSecret = process.env.WEBCASH_INPUT_SECRET;
const issuerUrl = process.env.WEBCASH_ISSUER_URL ?? "https://webcash.org";

const guarded = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !enabled || !inputSecret ? "set E2E=1 and WEBCASH_INPUT_SECRET to run" : false }, fn);

guarded("issuer health_check responds", async () => {
  const h = await issuerHealth(issuerUrl);
  assert.equal(h.ok, true, `health_check failed: status=${h.status}`);
});

guarded("settle replaces a real webcash secret end-to-end", async () => {
  const parsed = parseSecret(inputSecret!);
  assert.ok(parsed, "WEBCASH_INPUT_SECRET is malformed");

  const facilitator = new Facilitator();
  const req: FacilitatorRequest = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: "webcash",
        network: "webcash:mainnet",
        amount: parsed!.wats.toString(),
        asset: "webcash",
        payTo: issuerUrl,
        maxTimeoutSeconds: 60,
      },
      payload: { secret: inputSecret! },
    },
    paymentRequirements: {
      scheme: "webcash",
      network: "webcash:mainnet",
      amount: parsed!.wats.toString(),
      asset: "webcash",
      payTo: issuerUrl,
      maxTimeoutSeconds: 60,
    },
  };

  const result = await facilitator.settle(req);
  assert.equal(result.success, true, `settle failed: ${result.errorReason}`);
  const ext = result.extensions as { webcashOutput?: { secret: string } };
  assert.ok(ext?.webcashOutput?.secret, "no output secret in response");
  // eslint-disable-next-line no-console
  console.log(`[e2e] new output secret (save this): ${ext.webcashOutput!.secret}`);
});
