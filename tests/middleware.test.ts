import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import express from "express";
import { paywall, type WebcashOutput } from "../src/middleware.js";
import type { SettlementResponse } from "../src/types.js";

type FakeSettleHandler = (body: unknown) => SettlementResponse;

function startFakeFacilitator(handler: FakeSettleHandler): Promise<{ url: string; close: () => Promise<void>; calls: { settle: number } }> {
  return new Promise((resolveStart) => {
    const calls = { settle: 0 };
    const app = express();
    app.use(express.json());
    app.post("/settle", (req, res) => {
      calls.settle += 1;
      res.json(handler(req.body));
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

function startResourceServer(facilitatorUrl: string, onSettled?: (o: WebcashOutput) => void): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const app = express();
    app.get(
      "/premium",
      paywall({
        amountWats: 30_000_000n,
        facilitatorUrl,
        onSettled,
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
  const fac = await startFakeFacilitator(() => ({ success: true, transaction: "x", network: "webcash:mainnet" }));
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
  const fac = await startFakeFacilitator(() => ({
    success: true,
    transaction: "abc",
    network: "webcash:mainnet",
    amount: "30000000",
    extensions: {
      webcashOutput: {
        secret: "e0.3:secret:cafebabe",
        amountDecimal: "0.3",
        amountWats: "30000000",
      },
    },
  }));
  const server = await startResourceServer(fac.url, (o) => {
    received = o;
  });
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

test("middleware returns 402 when settlement fails", async () => {
  const fac = await startFakeFacilitator(() => ({
    success: false,
    errorReason: "issuer_rejected",
    transaction: "",
    network: "webcash:mainnet",
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

test("middleware returns 402 when onSettled throws (funds-moved error path)", async () => {
  const fac = await startFakeFacilitator(() => ({
    success: true,
    transaction: "abc",
    network: "webcash:mainnet",
    extensions: {
      webcashOutput: { secret: "e0.3:secret:cafebabe", amountDecimal: "0.3", amountWats: "30000000" },
    },
  }));
  const server = await startResourceServer(fac.url, () => {
    throw new Error("disk full");
  });
  try {
    const r = await fetchJson(`${server.url}/premium`, {
      headers: { "X-PAYMENT": encodePayload("e0.3:secret:abcdef") },
    });
    assert.equal(r.status, 402);
    const body = r.body as { error: string };
    assert.match(body.error, /output_persistence_failed/);
  } finally {
    await server.close();
    await fac.close();
  }
});
