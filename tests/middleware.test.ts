import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import express from "express";
import { paywall, type WebcashOutput } from "../src/middleware.js";
import type { SettlementResponse } from "../src/types.js";

type FakeHandler = (body: unknown) => { status?: number; body: unknown };

function startFakeFacilitator(handler: FakeHandler): Promise<{ url: string; close: () => Promise<void>; calls: { settle: number } }> {
  return new Promise((resolveStart) => {
    const calls = { settle: 0 };
    const app = express();
    app.use(express.json());
    app.post("/settle", (req, res) => {
      calls.settle += 1;
      const r = handler(req.body);
      res.status(r.status ?? 200).json(r.body);
    });
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        calls,
      });
    });
  });
}

type ServerOpts = {
  onSettled?: (o: WebcashOutput) => void;
  onSettledRecovery?: (o: WebcashOutput, e: unknown) => void;
};

function startResourceServer(facilitatorUrl: string, opts: ServerOpts = {}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const app = express();
    app.get(
      "/premium",
      paywall({
        amountWats: 30_000_000n,
        facilitatorUrl,
        onSettled: opts.onSettled,
        onSettledRecovery: opts.onSettledRecovery,
      }),
      (_req, res) => res.json({ ok: true }),
    );
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolveStart({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function fetchJson(url: string, init: http.RequestOptions & { headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolveReq, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: init.method ?? "GET", headers: init.headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolveReq({ status: res.statusCode ?? 0, headers: res.headers, body: data ? JSON.parse(data) : undefined });
          } catch {
            resolveReq({ status: res.statusCode ?? 0, headers: res.headers, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const successSettlement: SettlementResponse = {
  success: true,
  transaction: "abcfeed",
  network: "webcash:mainnet",
  amount: "30000000",
  extensions: {
    webcashOutput: { secret: "e0.3:secret:cafebabe", amountDecimal: "0.3", amountWats: "30000000" },
  },
};

function encodePayload(secret: string): string {
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "webcash",
      network: "webcash:mainnet",
      amount: "30000000",
      asset: "webcash",
      payTo: "https://webcash.org",
      maxTimeoutSeconds: 60,
    },
    payload: { secret },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

test("middleware returns 402 with PaymentRequired body when no header", async () => {
  const fac = await startFakeFacilitator(() => ({ body: successSettlement }));
  const server = await startResourceServer(fac.url);
  try {
    const r = await fetchJson(`${server.url}/premium`);
    assert.equal(r.status, 402);
    const body = r.body as { x402Version: number; accepts: Array<{ scheme: string }> };
    assert.equal(body.x402Version, 2);
    assert.equal(body.accepts[0]!.scheme, "webcash");
    assert.equal(fac.calls.settle, 0);
  } finally {
    await server.close();
    await fac.close();
  }
});

test("middleware allows request and invokes onSettled with the output secret", async () => {
  let received: WebcashOutput | null = null;
  const fac = await startFakeFacilitator(() => ({ body: successSettlement }));
  const server = await startResourceServer(fac.url, { onSettled: (o) => { received = o; } });
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.ok(received);
    assert.equal((received as WebcashOutput).secret, "e0.3:secret:cafebabe");
    assert.ok(typeof r.headers["x-payment-response"] === "string");
  } finally {
    await server.close();
    await fac.close();
  }
});

test("middleware returns 402 when settlement reports failure", async () => {
  const fac = await startFakeFacilitator(() => ({
    body: {
      success: false,
      errorReason: "issuer_rejected",
      transaction: "",
      network: "webcash:mainnet",
    },
  }));
  const server = await startResourceServer(fac.url);
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 402);
  } finally {
    await server.close();
    await fac.close();
  }
});

test("middleware returns 402 when facilitator returns 5xx (client may safely retry)", async () => {
  const fac = await startFakeFacilitator(() => ({ status: 502, body: { gateway: "down" } }));
  const server = await startResourceServer(fac.url);
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 402);
    const body = r.body as { error: string };
    assert.match(body.error, /facilitator returned HTTP 502/);
  } finally {
    await server.close();
    await fac.close();
  }
});

test("middleware returns 500 when onSettled throws (funds-already-moved path)", async () => {
  let recoveryCalled = false;
  const fac = await startFakeFacilitator(() => ({ body: successSettlement }));
  const server = await startResourceServer(fac.url, {
    onSettled: () => {
      throw new Error("disk full");
    },
    onSettledRecovery: () => {
      recoveryCalled = true;
    },
  });
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 500);
    const body = r.body as { error: string; transaction: string };
    assert.equal(body.error, "output_persistence_failed");
    assert.equal(body.transaction, "abcfeed");
    assert.equal(recoveryCalled, true);
  } finally {
    await server.close();
    await fac.close();
  }
});

test("middleware returns 500 when facilitator omits webcashOutput on success (integrity check)", async () => {
  const errs: string[] = [];
  const originalErr = console.error;
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  // Settlement reports success but never surfaces the new bearer secret.
  const fac = await startFakeFacilitator(() => ({
    body: {
      success: true,
      transaction: "deadbeef",
      network: "webcash:mainnet",
      amount: "30000000",
      // extensions deliberately omitted
    },
  }));
  let onSettledCalled = false;
  const server = await startResourceServer(fac.url, {
    onSettled: () => {
      onSettledCalled = true;
    },
  });
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 500);
    const body = r.body as { error: string; transaction: string };
    assert.equal(body.error, "settlement_integrity_failure");
    assert.equal(body.transaction, "deadbeef");
    assert.equal(onSettledCalled, false, "onSettled must NOT be called when output is missing");
    assert.ok(errs.some((s) => s.includes("[x402-webcash][CRITICAL]") && s.includes("missing_or_malformed_output_secret")));
  } finally {
    // eslint-disable-next-line no-console
    console.error = originalErr;
    await server.close();
    await fac.close();
  }
});

test("middleware returns 500 when webcashOutput is malformed (missing fields)", async () => {
  const originalErr = console.error;
  // eslint-disable-next-line no-console
  console.error = () => {}; // suppress critical log noise
  const fac = await startFakeFacilitator(() => ({
    body: {
      success: true,
      transaction: "deadbeef",
      network: "webcash:mainnet",
      amount: "30000000",
      extensions: {
        webcashOutput: { secret: "" }, // missing amountDecimal/amountWats, empty secret
      },
    },
  }));
  const server = await startResourceServer(fac.url, { onSettled: () => {} });
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 500);
    const body = r.body as { error: string };
    assert.equal(body.error, "settlement_integrity_failure");
  } finally {
    // eslint-disable-next-line no-console
    console.error = originalErr;
    await server.close();
    await fac.close();
  }
});

test("middleware logs to stderr even when both onSettled and recovery throw", async () => {
  const originalErr = console.error;
  const captured: string[] = [];
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  const fac = await startFakeFacilitator(() => ({ body: successSettlement }));
  const server = await startResourceServer(fac.url, {
    onSettled: () => {
      throw new Error("primary failed");
    },
    onSettledRecovery: () => {
      throw new Error("recovery also failed");
    },
  });
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 500);
    assert.ok(captured.some((s) => s.includes("[x402-webcash][CRITICAL]") && s.includes("e0.3:secret:cafebabe")));
    assert.ok(captured.some((s) => s.includes("recovery_callback_also_failed")));
  } finally {
    // eslint-disable-next-line no-console
    console.error = originalErr;
    await server.close();
    await fac.close();
  }
});
