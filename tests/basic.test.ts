import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Facilitator } from "../src/facilitator.js";
import { newOutputSecret, parseSecret, watsToDecimal } from "../src/webcash.js";
import type { FacilitatorRequest } from "../src/types.js";

test("parseSecret accepts valid form", () => {
  const p = parseSecret("e0.3:secret:abcdef");
  assert.ok(p);
  assert.equal(p!.decimal, "0.3");
  assert.equal(p!.hex, "abcdef");
  assert.equal(p!.wats, 30_000_000n);
});

test("parseSecret rejects malformed input", () => {
  assert.equal(parseSecret("not a secret"), null);
  assert.equal(parseSecret("e1:nope:abcdef"), null);
  assert.equal(parseSecret("e1.0:secret:NOTHEX"), null);
});

test("watsToDecimal round-trips integers and fractions", () => {
  assert.equal(watsToDecimal(100_000_000n), "1");
  assert.equal(watsToDecimal(30_000_000n), "0.3");
  assert.equal(watsToDecimal(1n), "0.00000001");
});

function fakeFetch(handlers: Record<string, (init: RequestInit) => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.endsWith(pattern)) return handler(init);
    }
    return new Response("not mocked", { status: 599 });
  }) as typeof fetch;
}

function buildReq(overrides: Partial<FacilitatorRequest["paymentRequirements"]> = {}, secret = "e0.3:secret:abcdef"): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: "webcash",
        network: "webcash:mainnet",
        amount: "30000000",
        asset: "webcash",
        payTo: "https://webcash.org",
        maxTimeoutSeconds: 60,
        ...overrides,
      },
      payload: { secret },
    },
    paymentRequirements: {
      scheme: "webcash",
      network: "webcash:mainnet",
      amount: "30000000",
      asset: "webcash",
      payTo: "https://webcash.org",
      maxTimeoutSeconds: 60,
      ...overrides,
    },
  };
}

test("verify rejects amount mismatch", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response("{}", { status: 200 }),
    }),
  });
  const req = buildReq({ amount: "40000000" });
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_webcash_amount_mismatch");
});

test("verify rejects malformed secret", async () => {
  const f = new Facilitator();
  const req = buildReq({}, "garbage");
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_webcash_secret_format");
});

test("verify rejects non-allowlisted issuer", async () => {
  const f = new Facilitator();
  const req = buildReq();
  req.paymentRequirements.extra = { issuerUrl: "https://evil.example" };
  req.paymentRequirements.payTo = "https://evil.example";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_network");
});

test("verify accepts a valid request when issuer is healthy", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response("{}", { status: 200 }),
    }),
  });
  const v = await f.verify(buildReq());
  assert.equal(v.isValid, true);
});

test("settle returns transaction = sha256 of input secret on success", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response("{}", { status: 200 }),
      "/api/v1/replace": () => new Response("{}", { status: 200 }),
    }),
    mintOutputSecret: () => newOutputSecret("0.3"),
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, true);
  assert.match(s.transaction, /^[0-9a-f]{64}$/);
  assert.equal(s.network, "webcash:mainnet");
  assert.equal(s.amount, "30000000");
});

test("settle surfaces issuer rejection as issuer_rejected", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response("{}", { status: 200 }),
      "/api/v1/replace": () => new Response(JSON.stringify({ error: "already spent" }), { status: 400 }),
    }),
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "issuer_rejected");
  assert.equal(s.transaction, "");
});

test("supported lists webcash kinds", () => {
  const f = new Facilitator();
  const sup = f.supported();
  const networks = sup.kinds.map((k) => k.network).sort();
  assert.deepEqual(networks, ["webcash:mainnet", "webcash:testnet"]);
  assert.ok(sup.kinds.every((k) => k.scheme === "webcash"));
});
