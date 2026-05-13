import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Facilitator } from "../src/facilitator.js";
import { decimalToWats, newOutputSecret, parseSecret, watsToDecimal } from "../src/webcash.js";
import type { FacilitatorRequest } from "../src/types.js";

test("parseSecret accepts valid form", () => {
  const p = parseSecret("e0.3:secret:abcdef");
  assert.ok(p);
  assert.equal(p!.decimal, "0.3");
  assert.equal(p!.hex, "abcdef");
  assert.equal(p!.wats, 30_000_000n);
  assert.equal(p!.raw, "e0.3:secret:abcdef");
});

test("parseSecret accepts whole-number amounts", () => {
  const p = parseSecret("e1:secret:abcdef");
  assert.ok(p);
  assert.equal(p!.wats, 100_000_000n);
});

test("parseSecret accepts up to 8 fractional digits", () => {
  const p = parseSecret("e0.00000001:secret:ab");
  assert.ok(p);
  assert.equal(p!.wats, 1n);
});

test("parseSecret normalizes decimal output (raw is preserved)", () => {
  const p = parseSecret("e1.30:secret:abcdef");
  assert.ok(p);
  assert.equal(p!.decimal, "1.3");
  assert.equal(p!.raw, "e1.30:secret:abcdef");
});

test("parseSecret rejects more than 8 fractional digits", () => {
  assert.equal(parseSecret("e0.123456789:secret:ab"), null);
});

test("parseSecret rejects whitespace", () => {
  assert.equal(parseSecret(" e0.3:secret:ab"), null);
  assert.equal(parseSecret("e0.3:secret:ab "), null);
  assert.equal(parseSecret("e0.3:secret: ab"), null);
});

test("parseSecret rejects uppercase hex", () => {
  assert.equal(parseSecret("e0.3:secret:ABCDEF"), null);
});

test("parseSecret rejects malformed input", () => {
  assert.equal(parseSecret("not a secret"), null);
  assert.equal(parseSecret("e1:nope:abcdef"), null);
  assert.equal(parseSecret("e1.0:secret:NOTHEX"), null);
});

test("parseSecret rejects zero amount", () => {
  assert.equal(parseSecret("e0:secret:abcdef"), null);
  assert.equal(parseSecret("e0.0:secret:abcdef"), null);
  assert.equal(parseSecret("e0.00000000:secret:abcdef"), null);
});

test("watsToDecimal round-trips integers and fractions", () => {
  assert.equal(watsToDecimal(100_000_000n), "1");
  assert.equal(watsToDecimal(30_000_000n), "0.3");
  assert.equal(watsToDecimal(1n), "0.00000001");
});

test("decimalToWats converts whole-number and fractional amounts", () => {
  assert.equal(decimalToWats("1"), 100_000_000n);
  assert.equal(decimalToWats("0.3"), 30_000_000n);
  assert.equal(decimalToWats("0.00000001"), 1n);
  assert.equal(decimalToWats("0.01"), 1_000_000n);
});

test("decimalToWats normalizes equivalent representations", () => {
  // "1.30" and "1.3" must produce the same wats — important so two prices
  // that the seller writes differently can't disagree on the wire.
  assert.equal(decimalToWats("1.30"), decimalToWats("1.3"));
  assert.equal(decimalToWats("1.30000000"), decimalToWats("1.3"));
});

test("decimalToWats round-trips with watsToDecimal", () => {
  for (const s of ["1", "0.3", "0.01", "0.00000001", "1000000.12345678"]) {
    assert.equal(watsToDecimal(decimalToWats(s)), s);
  }
});

test("decimalToWats rejects invalid input", () => {
  assert.throws(() => decimalToWats(""), TypeError);
  // @ts-expect-error — runtime check
  assert.throws(() => decimalToWats(null), TypeError);
  // @ts-expect-error
  assert.throws(() => decimalToWats(0.01), TypeError);
  assert.throws(() => decimalToWats("-1"), RangeError);
  assert.throws(() => decimalToWats("+1"), RangeError);
  assert.throws(() => decimalToWats(" 1"), RangeError);
  assert.throws(() => decimalToWats("1 "), RangeError);
  assert.throws(() => decimalToWats("0.123456789"), RangeError); // 9 fractional digits
  assert.throws(() => decimalToWats("1e2"), RangeError);
  assert.throws(() => decimalToWats("."), RangeError);
  assert.throws(() => decimalToWats(".5"), RangeError);
});

test("decimalToWats rejects zero", () => {
  assert.throws(() => decimalToWats("0"), RangeError);
  assert.throws(() => decimalToWats("0.0"), RangeError);
  assert.throws(() => decimalToWats("0.00000000"), RangeError);
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
  const accepted = {
    scheme: "webcash",
    network: "webcash:mainnet",
    amount: "30000000",
    asset: "webcash",
    payTo: "https://webcash.org",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted,
      payload: { secret },
    },
    paymentRequirements: { ...accepted },
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

test("verify rejects non-webcash network namespace", async () => {
  const f = new Facilitator();
  const req = buildReq({ network: "ach:us" });
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_network");
});

test("verify rejects non-allowlisted issuer override", async () => {
  const f = new Facilitator();
  const req = buildReq({ payTo: "https://evil.example" });
  req.paymentRequirements.extra = { issuerUrl: "https://evil.example" };
  req.paymentPayload.accepted.payTo = "https://evil.example";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_network");
});

test("verify rejects payTo that does not match canonical issuer", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response("{}", { status: 200 }),
    }),
  });
  const req = buildReq({ payTo: "https://attacker.example" });
  req.paymentPayload.accepted.payTo = "https://attacker.example";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_network");
});

test("verify rejects mismatched paymentPayload.accepted.scheme", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => new Response("{}", { status: 200 }),
    }),
  });
  const req = buildReq();
  req.paymentPayload.accepted.scheme = "exact";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_payload");
});

test("verify rejects mismatched accepted.payTo", async () => {
  const f = new Facilitator();
  const req = buildReq();
  req.paymentPayload.accepted.payTo = "https://different.example";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_payload");
});

test("verify rejects mismatched accepted.amount", async () => {
  const f = new Facilitator();
  const req = buildReq();
  req.paymentPayload.accepted.amount = "999";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_payload");
});

test("verify rejects mismatched accepted.asset", async () => {
  const f = new Facilitator();
  const req = buildReq();
  req.paymentPayload.accepted.asset = "usd";
  const v = await f.verify(req);
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, "invalid_payload");
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

test("verify caches issuer health within TTL", async () => {
  let healthCalls = 0;
  const f = new Facilitator({
    healthCacheTtlMs: 60_000,
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => {
        healthCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }),
  });
  await f.verify(buildReq());
  await f.verify(buildReq());
  await f.verify(buildReq());
  assert.equal(healthCalls, 1);
});

test("settle returns transaction = sha256 of input secret on success", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
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

test("settle exposes the output secret in extensions", async () => {
  const minted = newOutputSecret("0.3");
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/replace": () => new Response("{}", { status: 200 }),
    }),
    mintOutputSecret: () => minted,
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, true);
  const ext = s.extensions as { webcashOutput?: { secret: string; amountDecimal: string; amountWats: string } };
  assert.ok(ext?.webcashOutput);
  assert.equal(ext.webcashOutput!.secret, minted);
  assert.equal(ext.webcashOutput!.amountDecimal, "0.3");
  assert.equal(ext.webcashOutput!.amountWats, "30000000");
});

test("settle does not call /api/v1/health_check (replace is the round-trip)", async () => {
  let healthCalls = 0;
  let replaceCalls = 0;
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/health_check": () => {
        healthCalls += 1;
        return new Response("{}", { status: 200 });
      },
      "/api/v1/replace": () => {
        replaceCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }),
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, true);
  assert.equal(healthCalls, 0);
  assert.equal(replaceCalls, 1);
});

test("settle surfaces issuer rejection as issuer_rejected", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/replace": () => new Response(JSON.stringify({ error: "already spent" }), { status: 400 }),
    }),
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "issuer_rejected");
  assert.equal(s.transaction, "");
});

test("settle treats 200 with error body as failure (defensive)", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/replace": () =>
        new Response(JSON.stringify({ error: "amount mismatch" }), { status: 200 }),
    }),
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "issuer_rejected");
});

test("settle treats 200 with success:false body as failure", async () => {
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/replace": () =>
        new Response(JSON.stringify({ success: false, message: "insufficient balance" }), { status: 200 }),
    }),
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "insufficient_funds");
});

test("settle reports network errors as issuer_unreachable", async () => {
  const f = new Facilitator({
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, false);
  assert.equal(s.errorReason, "issuer_unreachable");
});

test("settle catches mintOutputSecret throws as unexpected_settle_error (without spending input)", async () => {
  let replaceCalls = 0;
  const f = new Facilitator({
    fetchImpl: fakeFetch({
      "/api/v1/replace": () => {
        replaceCalls += 1;
        return new Response("{}", { status: 200 });
      },
    }),
    mintOutputSecret: () => {
      throw new Error("wallet locked");
    },
  });
  const s = await f.settle(buildReq());
  assert.equal(s.success, false);
  assert.match(s.errorReason!, /^unexpected_settle_error:/);
  // Critically: replace was never called, so the input secret is still spendable.
  assert.equal(replaceCalls, 0);
});

test("settle sends configured legalese to /replace", async () => {
  let bodyJson: unknown = null;
  const f = new Facilitator({
    legalese: { terms: true, customDisclosure: true },
    fetchImpl: fakeFetch({
      "/api/v1/replace": (init) => {
        bodyJson = JSON.parse(String(init.body));
        return new Response("{}", { status: 200 });
      },
    }),
  });
  await f.settle(buildReq());
  const body = bodyJson as { legalese: Record<string, unknown> };
  assert.deepEqual(body.legalese, { terms: true, customDisclosure: true });
});

test("supported lists webcash kinds", () => {
  const f = new Facilitator();
  const sup = f.supported();
  const networks = sup.kinds.map((k) => k.network).sort();
  assert.deepEqual(networks, ["webcash:mainnet", "webcash:testnet"]);
  assert.ok(sup.kinds.every((k) => k.scheme === "webcash"));
});
