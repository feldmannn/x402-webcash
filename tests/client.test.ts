import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  FileWallet,
  MemoryWallet,
  NoMatchingSecretError,
  WEBCASH_SCHEME,
  buildWebcashHeader,
  wrapFetchWithWebcash,
} from "../src/client/index.js";
import type { PaymentRequired } from "../src/types.js";

const SECRET_0_3 = "e0.3:secret:abcdef0123456789";
const SECRET_1_0 = "e1:secret:cafebabe";

function paymentRequired(amount: string, extraSchemes: string[] = []): PaymentRequired {
  const webcash = {
    scheme: WEBCASH_SCHEME,
    network: "webcash:mainnet",
    amount,
    asset: "webcash",
    payTo: "https://webcash.org",
    maxTimeoutSeconds: 60,
  };
  const accepts = [
    ...extraSchemes.map((s) => ({
      scheme: s,
      network: "eip155:8453",
      amount,
      asset: "USDC",
      payTo: "0xabc",
      maxTimeoutSeconds: 60,
    })),
    webcash,
  ];
  return {
    x402Version: 2,
    error: "X-PAYMENT header is required",
    resource: { url: "http://localhost/premium" },
    accepts,
  };
}

type FakeServer = { url: string; close: () => Promise<void>; calls: { paid: number; unpaid: number } };

/**
 * Tiny resource server that emits 402 unless a configured "expected" header
 * is supplied, in which case it returns 200. Lets tests verify the wrapper
 * actually attaches X-PAYMENT and retries.
 */
function startFakeResourceServer(amount: string, opts: { onPaid?: (header: string) => { status: number; body: unknown } } = {}): Promise<FakeServer> {
  return new Promise((resolveStart) => {
    const calls = { paid: 0, unpaid: 0 };
    const app = express();
    app.get("/premium", (req, res) => {
      const header = req.header("X-PAYMENT");
      if (!header) {
        calls.unpaid += 1;
        res.status(402).json(paymentRequired(amount));
        return;
      }
      calls.paid += 1;
      const out = opts.onPaid?.(header) ?? { status: 200, body: { ok: true, header } };
      res.status(out.status).json(out.body);
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

function decodeHeader(headerB64: string): unknown {
  return JSON.parse(Buffer.from(headerB64, "base64").toString("utf8"));
}

test("buildWebcashHeader returns null when the 402 body does not advertise webcash", async () => {
  const wallet = new MemoryWallet([SECRET_0_3]);
  const body: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://x" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "30000000",
        asset: "USDC",
        payTo: "0xabc",
        maxTimeoutSeconds: 60,
      },
    ],
  };
  const built = await buildWebcashHeader(body, wallet);
  assert.equal(built, null);
  // Wallet must not have been touched.
  assert.deepEqual(await wallet.list(), [SECRET_0_3]);
});

test("buildWebcashHeader throws NoMatchingSecretError when wallet has no exact-amount secret", async () => {
  const wallet = new MemoryWallet([SECRET_1_0]); // 1.0 webcash, request wants 0.3
  await assert.rejects(
    () => buildWebcashHeader(paymentRequired("30000000"), wallet),
    (err: unknown) => err instanceof NoMatchingSecretError && err.wats === "30000000",
  );
  // Wallet must not have been touched on error.
  assert.deepEqual(await wallet.list(), [SECRET_1_0]);
});

test("buildWebcashHeader prefers webcash when multiple schemes are offered", async () => {
  const wallet = new MemoryWallet([SECRET_0_3]);
  const built = await buildWebcashHeader(paymentRequired("30000000", ["exact"]), wallet);
  assert.ok(built);
  const decoded = decodeHeader(built!.header) as { payload: { secret: string }; accepted: { scheme: string } };
  assert.equal(decoded.accepted.scheme, "webcash");
  assert.equal(decoded.payload.secret, SECRET_0_3);
  // Secret was taken atomically.
  assert.deepEqual(await wallet.list(), []);
});

test("wrapFetchWithWebcash auto-pays a 402 and returns the 200", async () => {
  const server = await startFakeResourceServer("30000000");
  const wallet = new MemoryWallet([SECRET_0_3]);
  const pay = wrapFetchWithWebcash(fetch, { wallet });
  try {
    const res = await pay(`${server.url}/premium`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; header: string };
    assert.equal(body.ok, true);
    const decoded = decodeHeader(body.header) as { payload: { secret: string } };
    assert.equal(decoded.payload.secret, SECRET_0_3);
    // One unpaid probe + one paid retry.
    assert.equal(server.calls.unpaid, 1);
    assert.equal(server.calls.paid, 1);
    // Secret was spent and not returned to the wallet.
    assert.deepEqual(await wallet.list(), []);
  } finally {
    await server.close();
  }
});

test("wrapFetchWithWebcash returns the secret to the wallet when the retry is also 402", async () => {
  // Resource server returns 402 even when X-PAYMENT is present — simulates a
  // facilitator outage / settlement rejection on the server side.
  const server = await startFakeResourceServer("30000000", {
    onPaid: () => ({ status: 402, body: paymentRequired("30000000") }),
  });
  const wallet = new MemoryWallet([SECRET_0_3]);
  const pay = wrapFetchWithWebcash(fetch, { wallet });
  try {
    const res = await pay(`${server.url}/premium`);
    assert.equal(res.status, 402);
    // Secret must be back in the wallet — settlement did not run.
    assert.deepEqual(await wallet.list(), [SECRET_0_3]);
  } finally {
    await server.close();
  }
});

test("wrapFetchWithWebcash quarantines the secret on ambiguous (non-2xx, non-402) status", async () => {
  const server = await startFakeResourceServer("30000000", {
    onPaid: () => ({ status: 500, body: { error: "settlement_integrity_failure" } }),
  });
  const wallet = new MemoryWallet([SECRET_0_3]);
  const quarantined: string[] = [];

  // Silence stderr [CRITICAL] noise.
  const originalErr = console.error;
  // eslint-disable-next-line no-console
  console.error = () => {};

  try {
    const pay = wrapFetchWithWebcash(fetch, {
      wallet,
      onAmbiguous: ({ secret, status }) => {
        quarantined.push(`${status}:${secret}`);
      },
    });
    const res = await pay(`${server.url}/premium`);
    assert.equal(res.status, 500);
    // Quarantine hook fired with the secret + status.
    assert.deepEqual(quarantined, [`500:${SECRET_0_3}`]);
    // Secret is NOT returned to the wallet (possibly spent at issuer).
    assert.deepEqual(await wallet.list(), []);
  } finally {
    // eslint-disable-next-line no-console
    console.error = originalErr;
    await server.close();
  }
});

test("wrapFetchWithWebcash propagates NoMatchingSecretError when wallet has no funds", async () => {
  const server = await startFakeResourceServer("30000000");
  const wallet = new MemoryWallet([SECRET_1_0]); // wrong denomination
  const pay = wrapFetchWithWebcash(fetch, { wallet });
  try {
    await assert.rejects(
      () => pay(`${server.url}/premium`),
      (err: unknown) => err instanceof NoMatchingSecretError,
    );
    // 1.0 secret should still be untouched.
    assert.deepEqual(await wallet.list(), [SECRET_1_0]);
  } finally {
    await server.close();
  }
});

test("wrapFetchWithWebcash passes through non-402 responses untouched", async () => {
  const app = express();
  app.get("/free", (_req, res) => res.json({ free: true }));
  const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolveStart) => {
    const s = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolveStart({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });
  const wallet = new MemoryWallet([SECRET_0_3]);
  const pay = wrapFetchWithWebcash(fetch, { wallet });
  try {
    const res = await pay(`${server.url}/free`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { free: true });
    assert.deepEqual(await wallet.list(), [SECRET_0_3]);
  } finally {
    await server.close();
  }
});

test("FileWallet survives a take + put round-trip and rejects malformed secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webcash-wallet-"));
  const path = join(dir, "wallet.json");
  try {
    const w = new FileWallet(path);
    await w.put(SECRET_0_3);
    await w.put(SECRET_1_0);
    assert.deepEqual((await w.list()).sort(), [SECRET_0_3, SECRET_1_0].sort());

    const taken = await w.takeExact("30000000");
    assert.equal(taken, SECRET_0_3);
    assert.deepEqual(await w.list(), [SECRET_1_0]);

    assert.equal(await w.takeExact("30000000"), null);

    await assert.rejects(() => w.put("not a webcash secret"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileWallet returns [] for a non-existent file rather than throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webcash-wallet-"));
  const path = join(dir, "missing.json");
  try {
    const w = new FileWallet(path);
    assert.deepEqual(await w.list(), []);
    assert.equal(await w.takeExact("30000000"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
