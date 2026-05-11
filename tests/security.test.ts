import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { Facilitator, isAcceptableIssuerScheme } from "../src/facilitator.js";
import { paywall } from "../src/middleware.js";
import {
  FileWallet,
  InsecureIssuerError,
  MemoryWallet,
  WEBCASH_SCHEME,
  splitToMatch,
  wrapFetchWithWebcash,
} from "../src/client/index.js";
import type { PaymentRequired } from "../src/types.js";

const SECRET_0_3 = "e0.3:secret:abcdef0123456789";

// -------------------- HTTPS enforcement --------------------

test("isAcceptableIssuerScheme: https passes; loopback http passes; remote http fails", () => {
  assert.equal(isAcceptableIssuerScheme("https://webcash.org", false), true);
  assert.equal(isAcceptableIssuerScheme("http://localhost:4021", false), true);
  assert.equal(isAcceptableIssuerScheme("http://127.0.0.1:4021", false), true);
  assert.equal(isAcceptableIssuerScheme("http://[::1]:4021", false), true);
  assert.equal(isAcceptableIssuerScheme("http://evil.example.com", false), false);
  assert.equal(isAcceptableIssuerScheme("ftp://webcash.org", false), false);
  assert.equal(isAcceptableIssuerScheme("not a url", false), false);
});

test("isAcceptableIssuerScheme: allowHttp opens any well-formed http URL", () => {
  assert.equal(isAcceptableIssuerScheme("http://evil.example.com", true), true);
  // Still rejects garbage URLs.
  assert.equal(isAcceptableIssuerScheme("not a url", true), false);
  // Still rejects other schemes.
  assert.equal(isAcceptableIssuerScheme("ftp://webcash.org", true), false);
});

test("Facilitator constructor: throws when an allowlisted URL is non-HTTPS remote", () => {
  assert.throws(
    () => new Facilitator({ issuerAllowlist: ["http://evil.example.com"] }),
    /not HTTPS and not loopback/,
  );
});

test("Facilitator constructor: accepts an http loopback in the allowlist", () => {
  // No throw expected.
  new Facilitator({ issuerAllowlist: ["http://127.0.0.1:9999"] });
});

test("Facilitator constructor: accepts non-HTTPS allowlist when allowHttpIssuer:true", () => {
  // No throw expected.
  new Facilitator({
    issuerAllowlist: ["http://sandbox.example.com"],
    allowHttpIssuer: true,
  });
});

test("paywall middleware: throws on non-HTTPS non-loopback facilitator URL", () => {
  assert.throws(
    () =>
      paywall({
        amountWats: 30_000_000n,
        facilitatorUrl: "http://evil.example.com:4021",
      }),
    /Refusing to install paywall/,
  );
});

test("paywall middleware: accepts loopback facilitator URL", () => {
  // No throw.
  paywall({
    amountWats: 30_000_000n,
    facilitatorUrl: "http://127.0.0.1:4021",
    onSettled: () => {},
  });
});

test("paywall middleware: accepts non-loopback facilitator URL when allowHttpFacilitator:true", () => {
  // No throw.
  paywall({
    amountWats: 30_000_000n,
    facilitatorUrl: "http://sandbox.example.com:4021",
    allowHttpFacilitator: true,
    onSettled: () => {},
  });
});

test("splitToMatch: throws InsecureIssuerError on remote http issuer URL", async () => {
  const wallet = new MemoryWallet(["e1:secret:cafebabe"]);
  await assert.rejects(
    () => splitToMatch(wallet, "30000000", { issuerUrl: "http://evil.example.com" }),
    (err: unknown) => err instanceof InsecureIssuerError,
  );
});

test("splitToMatch: does NOT touch the wallet when the issuer URL is rejected", async () => {
  const wallet = new MemoryWallet(["e1:secret:cafebabe"]);
  await assert.rejects(() =>
    splitToMatch(wallet, "30000000", { issuerUrl: "http://evil.example.com" }),
  );
  // Wallet untouched — the precheck fires before any list/take.
  assert.deepEqual(await wallet.list(), ["e1:secret:cafebabe"]);
});

// -------------------- FileWallet concurrency --------------------

test("FileWallet: 50 concurrent takeExact calls each receive a distinct secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webcash-conc-"));
  const path = join(dir, "wallet.json");
  try {
    const w = new FileWallet(path);
    const N = 50;
    // Seed exactly N matching 0.3 secrets.
    for (let i = 0; i < N; i++) {
      await w.put(`e0.3:secret:${i.toString(16).padStart(64, "0")}`);
    }
    // Fire 2N concurrent takes — N should succeed, N should return null.
    const promises = Array.from({ length: N * 2 }, () => w.takeExact("30000000"));
    const results = await Promise.all(promises);
    const successes = results.filter((r) => r !== null) as string[];
    const failures = results.filter((r) => r === null);
    assert.equal(successes.length, N, `expected ${N} successes, got ${successes.length}`);
    assert.equal(failures.length, N, `expected ${N} failures, got ${failures.length}`);
    // Every success must be distinct — no double-spend.
    assert.equal(new Set(successes).size, successes.length, "duplicate secrets handed out");
    // Wallet is empty.
    assert.deepEqual(await w.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileWallet: concurrent puts + takes converge to a consistent state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webcash-conc-"));
  const path = join(dir, "wallet.json");
  try {
    const w = new FileWallet(path);
    // Start with 10 secrets.
    for (let i = 0; i < 10; i++) {
      await w.put(`e0.1:secret:${("a" + i.toString(16)).padStart(64, "0")}`);
    }
    // Interleave: 10 takes, 10 puts of a different denomination, all concurrent.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(w.takeExact("10000000")); // 0.1 webcash = 10_000_000 wats
      ops.push(w.put(`e0.2:secret:${("b" + i.toString(16)).padStart(64, "0")}`));
    }
    await Promise.all(ops);
    const remaining = await w.list();
    // All 10 of the 0.1 secrets should be gone, all 10 of the 0.2 secrets present.
    assert.equal(remaining.length, 10);
    assert.ok(remaining.every((s) => s.startsWith("e0.2:secret:")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------- Journal hook on wrapFetchWithWebcash --------------------

function startFakeResourceServer(amount: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const app = express();
    app.get("/premium", (req, res) => {
      if (!req.header("X-PAYMENT")) {
        const body: PaymentRequired = {
          x402Version: 2,
          error: "X-PAYMENT header is required",
          resource: { url: "http://x/premium" },
          accepts: [
            {
              scheme: WEBCASH_SCHEME,
              network: "webcash:mainnet",
              amount,
              asset: "webcash",
              payTo: "https://webcash.org",
              maxTimeoutSeconds: 60,
            },
          ],
        };
        res.status(402).json(body);
        return;
      }
      res.json({ ok: true });
    });
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

test("wrapFetchWithWebcash: journal hook fires with the secret BEFORE the retry is sent", async () => {
  const server = await startFakeResourceServer("30000000");
  const wallet = new MemoryWallet([SECRET_0_3]);
  const journaled: Array<{ secret: string; amountWats: string; url: string }> = [];
  const pay = wrapFetchWithWebcash(fetch, {
    wallet,
    journal: (info) => {
      journaled.push(info);
    },
  });
  try {
    const res = await pay(`${server.url}/premium`);
    assert.equal(res.status, 200);
    assert.equal(journaled.length, 1);
    assert.equal(journaled[0]!.secret, SECRET_0_3);
    assert.equal(journaled[0]!.amountWats, "30000000");
    assert.match(journaled[0]!.url, /\/premium$/);
  } finally {
    await server.close();
  }
});

test("wrapFetchWithWebcash: when journal throws, the secret is returned to the wallet and request fails", async () => {
  const server = await startFakeResourceServer("30000000");
  const wallet = new MemoryWallet([SECRET_0_3]);
  const pay = wrapFetchWithWebcash(fetch, {
    wallet,
    journal: () => {
      throw new Error("journal disk full");
    },
  });
  try {
    await assert.rejects(() => pay(`${server.url}/premium`), /journal disk full/);
    // Secret must have been returned to the wallet — the request did not run.
    assert.deepEqual(await wallet.list(), [SECRET_0_3]);
  } finally {
    await server.close();
  }
});
