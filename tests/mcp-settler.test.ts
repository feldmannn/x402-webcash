// Tests for webcashSettler — the x402-mcp adapter. Uses a real Facilitator
// with a fake fetch so we exercise the validate → /replace → output-secret
// integrity path end-to-end.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Facilitator } from "../src/facilitator.js";
import { webcashSettler } from "../src/mcp-settler.js";
import type { PaymentPayload, PaymentRequirements, WebcashPayload } from "../src/types.js";

const SECRET = "e1:secret:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const REQUIRED_WATS = "100000000";

function fakeFetch(
  responses: Record<string, (init: RequestInit) => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(responses)) {
      if (url.endsWith(pattern)) return handler(init);
    }
    return new Response("not mocked", { status: 599 });
  }) as typeof fetch;
}

function buildPaymentInput(): {
  payload: PaymentPayload<WebcashPayload>;
  requirements: PaymentRequirements;
} {
  const requirements: PaymentRequirements = {
    scheme: "webcash",
    network: "webcash:mainnet",
    amount: REQUIRED_WATS,
    asset: "webcash",
    payTo: "https://webcash.org",
    maxTimeoutSeconds: 60,
  };
  const payload: PaymentPayload<WebcashPayload> = {
    x402Version: 2,
    accepted: { ...requirements },
    payload: { secret: SECRET },
  };
  return { payload, requirements };
}

test("webcashSettler maps success to ok:true with output secret", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      "/api/v1/replace": () => new Response(JSON.stringify({ status: "success" }), { status: 200 }),
    }),
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  const result = await settler(payload, requirements);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.output.secret.startsWith("e1:secret:"));
    assert.equal(result.output.amountDecimal, "1");
    assert.equal(result.output.amountWats, REQUIRED_WATS);
    assert.ok(result.transaction.length > 0, "expected a non-empty transaction id");
  }
});

test("webcashSettler maps issuer rejection to ok:false retriable:false", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      "/api/v1/replace": () =>
        new Response(JSON.stringify({ error: "secret already spent" }), { status: 400 }),
    }),
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  const result = await settler(payload, requirements);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retriable, false, "issuer rejection is NOT retriable with same input");
    assert.ok(result.reason.length > 0);
  }
});

test("webcashSettler maps validation failure (amount mismatch) to retriable:false", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  // Tamper: requirements say 100000000 wats, but the payload secret is for 1 webcash = 100000000.
  // Force a mismatch by changing the required amount.
  const mismatched = { ...requirements, amount: "50000000" };
  const mismatchedPayload = {
    ...payload,
    accepted: { ...payload.accepted, amount: "50000000" },
  };

  const result = await settler(mismatchedPayload, mismatched);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retriable, false);
    assert.match(result.reason, /invalid_webcash_amount_mismatch/);
  }
});

test("webcashSettler maps mint failure (unexpected_settle_error) to retriable:true", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
    mintOutputSecret: () => {
      throw new Error("wallet I/O exhausted");
    },
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  const result = await settler(payload, requirements);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retriable, true, "facilitator-side mint failure is safe to retry — issuer untouched");
    assert.match(result.reason, /unexpected_settle_error/);
  }
});

test("webcashSettler rejects output secrets whose embedded amount disagrees with requirements", async () => {
  // Simulate a compromised facilitator: it mints an output secret for a
  // SMALLER amount than the buyer paid. The facilitator's own /replace
  // call would actually fail at a real issuer (amount conservation), but
  // we mock the replace step to succeed — what we're testing is whether
  // webcashSettler catches this BEFORE persisting. This is the defense
  // against a facilitator that's been backdoored to skim funds.
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      "/api/v1/replace": () => new Response(JSON.stringify({ status: "success" }), { status: 200 }),
    }),
    // Buyer is paying 1 webcash; malicious facilitator mints a 1-wat output.
    mintOutputSecret: () => "e0.00000001:secret:cafebabe",
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  const result = await settler(payload, requirements);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retriable, false);
    assert.match(result.reason, /settlement_integrity_failure: output amount/);
    assert.match(result.reason, /1 wats does not match required 100000000 wats/);
  }
});

test("webcashSettler rejects output secrets that do not parse as webcash", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      "/api/v1/replace": () => new Response(JSON.stringify({ status: "success" }), { status: 200 }),
    }),
    mintOutputSecret: () => "not-a-webcash-secret",
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  const result = await settler(payload, requirements);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retriable, false);
    assert.match(result.reason, /output secret does not parse as webcash/);
  }
});

test("webcashSettler enforces the output-secret integrity gate", async () => {
  // Build a Facilitator that returns success but, via a custom mint that
  // produces a malformed secret, fails the WebcashOutput shape check.
  // We can't easily make Facilitator return success-without-extensions
  // since it always populates them, so we verify the gate works against
  // a malformed-secret output instead.
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      "/api/v1/replace": () => new Response(JSON.stringify({ status: "success" }), { status: 200 }),
    }),
    mintOutputSecret: () => "", // empty string fails isValidOutput
  });
  const settler = webcashSettler(f);
  const { payload, requirements } = buildPaymentInput();

  const result = await settler(payload, requirements);

  // Empty secret bypasses the mint-failure throw path but should still
  // make the output fail isValidOutput. Note: an empty string output
  // becomes `secret: ""` in the WebcashOutput, which we reject.
  // Actually, the facilitator builds the output object with empty
  // secret string — our isValidOutput requires length > 0, so this trips.
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.retriable, false);
    assert.match(result.reason, /settlement_integrity_failure/);
  }
});
