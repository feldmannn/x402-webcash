// paywallLocal: in-process facilitator paywall.
//
// Same integrity gates and persistence contract as paywall, but bypasses
// HTTP entirely — closes the third-party facilitator trust boundary for
// self-hosted deployments. These tests use a structural Facilitator fake
// to focus on the wiring (the real Facilitator's settle() is covered
// elsewhere).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import express from "express";
import { paywallLocal, type WebcashOutput } from "../src/middleware.js";
import type { Facilitator } from "../src/facilitator.js";
import type { FacilitatorRequest, SettlementResponse } from "../src/types.js";

function fakeFacilitator(
  fn: (req: FacilitatorRequest) => SettlementResponse | Promise<SettlementResponse>,
): Facilitator {
  return { settle: async (req) => fn(req) } as unknown as Facilitator;
}

type ServerOpts = {
  onSettled?: (o: WebcashOutput) => void | Promise<void>;
  onSettledRecovery?: (o: WebcashOutput, e: unknown) => void | Promise<void>;
};

async function startResourceServer(
  facilitator: Facilitator,
  opts: ServerOpts = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const app = express();
    app.get(
      "/premium",
      paywallLocal(facilitator, {
        amountWats: 30_000_000n,
        onSettled: opts.onSettled,
        onSettledRecovery: opts.onSettledRecovery,
      }),
      (_req, res) => res.json({ ok: true, resource: "premium" }),
    );
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveReq, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolveReq({
              status: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : undefined,
            });
          } catch {
            resolveReq({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function paymentHeader(secret: string, amount: string = "30000000"): string {
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "webcash",
      network: "webcash:mainnet",
      amount,
      asset: "webcash",
      payTo: "https://webcash.org",
      maxTimeoutSeconds: 60,
    },
    payload: { secret },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

const VALID_OUTPUT: WebcashOutput = {
  secret: "e0.3:secret:cafebabe",
  amountDecimal: "0.3",
  amountWats: "30000000",
};

const SUCCESS_RESPONSE: SettlementResponse = {
  success: true,
  transaction: "abc123",
  network: "webcash:mainnet",
  amount: "30000000",
  extensions: { webcashOutput: VALID_OUTPUT },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("paywallLocal: happy path serves the resource on valid payment and invokes onSettled", async () => {
  let captured: WebcashOutput | null = null;
  let settleCalls = 0;
  const fac = fakeFacilitator(() => {
    settleCalls += 1;
    return SUCCESS_RESPONSE;
  });
  const server = await startResourceServer(fac, {
    onSettled: (o) => {
      captured = o;
    },
  });
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, resource: "premium" });
    assert.equal(settleCalls, 1);
    assert.equal((captured as WebcashOutput | null)?.secret, VALID_OUTPUT.secret);
  } finally {
    await server.close();
  }
});

test("paywallLocal: returns 402 PaymentRequired when X-PAYMENT header is absent", async () => {
  const fac = fakeFacilitator(() => {
    throw new Error("settle should not be called");
  });
  const server = await startResourceServer(fac);
  try {
    const res = await fetchJson(`${server.url}/premium`);
    assert.equal(res.status, 402);
    const body = res.body as { x402Version: number; error: string; accepts: unknown[] };
    assert.equal(body.x402Version, 2);
    assert.match(body.error, /X-PAYMENT header is required/);
    assert.ok(Array.isArray(body.accepts));
  } finally {
    await server.close();
  }
});

test("paywallLocal: returns 402 when X-PAYMENT is not base64-JSON", async () => {
  const fac = fakeFacilitator(() => {
    throw new Error("settle should not be called");
  });
  const server = await startResourceServer(fac);
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": "not-base64-json-!!!" },
    });
    assert.equal(res.status, 402);
    const body = res.body as { error: string };
    assert.match(body.error, /base64-encoded JSON/);
  } finally {
    await server.close();
  }
});

test("paywallLocal: returns 402 when settle reports success:false", async () => {
  const fac = fakeFacilitator(() => ({
    success: false,
    errorReason: "issuer_rejected",
    transaction: "",
    network: "webcash:mainnet",
  }));
  const server = await startResourceServer(fac);
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 402);
    const body = res.body as { error: string };
    assert.match(body.error, /issuer_rejected/);
  } finally {
    await server.close();
  }
});

test("paywallLocal: returns 500 when settle reports success without webcashOutput (integrity gate)", async () => {
  const fac = fakeFacilitator(() => ({
    success: true,
    transaction: "tx1",
    network: "webcash:mainnet",
    // Missing extensions.webcashOutput — the facilitator settled at the
    // issuer but didn't surface the new secret. Funds may be lost.
  }));
  const server = await startResourceServer(fac);
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 500);
    const body = res.body as { error: string; transaction: string };
    assert.equal(body.error, "settlement_integrity_failure");
    assert.equal(body.transaction, "tx1");
  } finally {
    await server.close();
  }
});

test("paywallLocal: returns 500 when onSettled throws (funds-already-moved path)", async () => {
  let recoveryFired = false;
  const fac = fakeFacilitator(() => SUCCESS_RESPONSE);
  const server = await startResourceServer(fac, {
    onSettled: () => {
      throw new Error("disk full");
    },
    onSettledRecovery: () => {
      recoveryFired = true;
    },
  });
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 500);
    const body = res.body as { error: string };
    assert.equal(body.error, "output_persistence_failed");
    assert.ok(recoveryFired, "recovery hook should have been called");
  } finally {
    await server.close();
  }
});

test("paywallLocal: returns 402 when facilitator.settle() unexpectedly throws", async () => {
  // Defensive: facilitator.settle() is contractually total, but if it does
  // throw the input was NOT transmitted to the issuer — so retry-safe.
  const fac = fakeFacilitator(() => {
    throw new Error("synthetic crash");
  });
  const server = await startResourceServer(fac);
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 402);
    const body = res.body as { error: string };
    assert.match(body.error, /unexpected_facilitator_throw/);
  } finally {
    await server.close();
  }
});

test("paywallLocal: serves resource even with no onSettled (warning is emitted but request succeeds)", async () => {
  // Mirrors paywall behavior — no persistence means funds are LOST, but the
  // request itself still serves 200 (the warning is the operator's signal).
  const fac = fakeFacilitator(() => SUCCESS_RESPONSE);
  const server = await startResourceServer(fac, {});
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

test("paywallLocal: passes through requirements to settle() correctly", async () => {
  let receivedReq: FacilitatorRequest | null = null;
  const fac = fakeFacilitator((req) => {
    receivedReq = req;
    return SUCCESS_RESPONSE;
  });
  const server = await startResourceServer(fac);
  try {
    const res = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": paymentHeader("e0.3:secret:deadbeef") },
    });
    assert.equal(res.status, 200);
    assert.ok(receivedReq);
    const r = receivedReq as unknown as FacilitatorRequest;
    assert.equal(r.x402Version, 2);
    assert.equal(r.paymentRequirements.scheme, "webcash");
    assert.equal(r.paymentRequirements.amount, "30000000");
    assert.equal(r.paymentRequirements.network, "webcash:mainnet");
    assert.equal(r.paymentRequirements.asset, "webcash");
    assert.equal(r.paymentRequirements.payTo, "https://webcash.org");
  } finally {
    await server.close();
  }
});
