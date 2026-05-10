import { strict as assert } from "node:assert";
import { test } from "node:test";
import express from "express";
import {
  AmbiguousSplitError,
  IssuerRejectedSplitError,
  MemoryWallet,
  WEBCASH_SCHEME,
  buildWebcashHeader,
  splitToMatch,
  wrapFetchWithWebcash,
} from "../src/client/index.js";
import type { PaymentRequired } from "../src/types.js";

const SECRET_1_0 = "e1:secret:cafebabe";
const SECRET_0_5 = "e0.5:secret:beadfeed";
const SECRET_2_0 = "e2:secret:deadc0de";

type ReplaceCall = { webcashes: string[]; new_webcashes: string[]; legalese: unknown };

function startFakeIssuer(behavior: "success" | "rejected" | "drop"): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: ReplaceCall[];
}> {
  return new Promise((resolveStart) => {
    const calls: ReplaceCall[] = [];
    const app = express();
    app.use(express.json());
    app.post("/api/v1/replace", (req, res) => {
      calls.push(req.body as ReplaceCall);
      if (behavior === "success") {
        res.json({ status: "success" });
        return;
      }
      if (behavior === "rejected") {
        res.status(400).json({ error: "issuer_rejected_test" });
        return;
      }
      // "drop": never respond — the client will hit its timeout.
      // Close the socket to provoke a fast network error instead of waiting.
      req.socket.destroy();
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

function silenceStderr(): () => string[] {
  const captured: string[] = [];
  const original = console.error;
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  return () => {
    // eslint-disable-next-line no-console
    console.error = original;
    return captured;
  };
}

// Deterministic minter so we can assert on output secrets.
function makeDeterministicMinter(): (amountDecimal: string) => string {
  let i = 0;
  return (amountDecimal) => {
    i += 1;
    return `e${amountDecimal}:secret:${"ab".repeat(16)}${i.toString(16).padStart(2, "0")}`;
  };
}

test("splitToMatch returns null when no secret is larger than required", async () => {
  const issuer = await startFakeIssuer("success");
  const wallet = new MemoryWallet([SECRET_0_5]); // 0.5, need 1.0
  try {
    const result = await splitToMatch(wallet, "100000000", { issuerUrl: issuer.url });
    assert.equal(result, null);
    // Issuer must not have been called.
    assert.equal(issuer.calls.length, 0);
    // Wallet untouched.
    assert.deepEqual(await wallet.list(), [SECRET_0_5]);
  } finally {
    await issuer.close();
  }
});

test("splitToMatch best-fit: picks the smallest secret larger than required", async () => {
  const issuer = await startFakeIssuer("success");
  const restore = silenceStderr();
  const wallet = new MemoryWallet([SECRET_2_0, SECRET_1_0]); // need 0.3 -> should pick 1.0
  const mint = makeDeterministicMinter();
  try {
    const taken = await splitToMatch(wallet, "30000000", {
      issuerUrl: issuer.url,
      mintOutputSecret: mint,
    });
    // Required output minted first (0.3), then change (0.7).
    assert.equal(taken, "e0.3:secret:abababababababababababababababab01");
    // The 2.0 secret must remain untouched.
    const remaining = await wallet.list();
    assert.ok(remaining.includes(SECRET_2_0));
    // The 1.0 secret should be gone, the 0.7 change should be present.
    assert.ok(!remaining.includes(SECRET_1_0));
    assert.ok(remaining.some((s) => s.startsWith("e0.7:secret:")));
    // Issuer received exactly one replace call with the right inputs/outputs.
    assert.equal(issuer.calls.length, 1);
    assert.deepEqual(issuer.calls[0]!.webcashes, [SECRET_1_0]);
    assert.equal(issuer.calls[0]!.new_webcashes.length, 2);
    assert.ok(issuer.calls[0]!.new_webcashes[0]!.startsWith("e0.3:secret:"));
    assert.ok(issuer.calls[0]!.new_webcashes[1]!.startsWith("e0.7:secret:"));
  } finally {
    restore();
    await issuer.close();
  }
});

test("splitToMatch on clean issuer rejection restores the input to the wallet", async () => {
  const issuer = await startFakeIssuer("rejected");
  const restore = silenceStderr();
  const wallet = new MemoryWallet([SECRET_1_0]);
  try {
    await assert.rejects(
      () => splitToMatch(wallet, "30000000", { issuerUrl: issuer.url }),
      (err: unknown) => err instanceof IssuerRejectedSplitError,
    );
    // Input is back in the wallet — it was not spent at the issuer.
    assert.deepEqual(await wallet.list(), [SECRET_1_0]);
  } finally {
    restore();
    await issuer.close();
  }
});

test("splitToMatch on network failure does NOT restore the input (ambiguous), logs CRITICAL breadcrumb", async () => {
  const issuer = await startFakeIssuer("drop");
  const restore = silenceStderr();
  const wallet = new MemoryWallet([SECRET_1_0]);
  const mint = makeDeterministicMinter();
  try {
    await assert.rejects(
      () =>
        splitToMatch(wallet, "30000000", {
          issuerUrl: issuer.url,
          timeoutMs: 200,
          mintOutputSecret: mint,
        }),
      (err: unknown) => err instanceof AmbiguousSplitError,
    );
    // Input is NOT restored — it might be spent.
    assert.deepEqual(await wallet.list(), []);
  } finally {
    const logs = restore();
    assert.ok(
      logs.some((l) => l.includes("[x402-webcash][CRITICAL]") && l.includes("split_ambiguous")),
      `expected split_ambiguous breadcrumb in stderr; got: ${logs.join(" | ")}`,
    );
    assert.ok(
      logs.some((l) => l.includes("[x402-webcash][CRITICAL]") && l.includes("split_pending")),
      `expected split_pending breadcrumb in stderr; got: ${logs.join(" | ")}`,
    );
    await issuer.close();
  }
});

test("splitToMatch throws if it cannot persist change, and logs CRITICAL with the change secret", async () => {
  const issuer = await startFakeIssuer("success");
  const restore = silenceStderr();
  const wallet = new MemoryWallet([SECRET_1_0]);
  // Sabotage put so persisting change fails.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (wallet as any).put = async () => {
    throw new Error("disk full");
  };
  try {
    await assert.rejects(
      () =>
        splitToMatch(wallet, "30000000", {
          issuerUrl: issuer.url,
          mintOutputSecret: makeDeterministicMinter(),
        }),
      /disk full/,
    );
  } finally {
    const logs = restore();
    assert.ok(
      logs.some(
        (l) =>
          l.includes("[x402-webcash][CRITICAL]") && l.includes("change_persistence_failed"),
      ),
      `expected change_persistence_failed breadcrumb; got: ${logs.join(" | ")}`,
    );
    await issuer.close();
  }
});

test("buildWebcashHeader with autoSplit falls back to split when wallet has no exact match", async () => {
  const issuer = await startFakeIssuer("success");
  const restore = silenceStderr();
  const wallet = new MemoryWallet([SECRET_1_0]); // only have 1.0, need 0.3
  const body: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://x" },
    accepts: [
      {
        scheme: WEBCASH_SCHEME,
        network: "webcash:mainnet",
        amount: "30000000",
        asset: "webcash",
        payTo: issuer.url, // facilitator will settle here too
        maxTimeoutSeconds: 60,
      },
    ],
  };
  try {
    const built = await buildWebcashHeader(body, wallet, {
      autoSplit: { mintOutputSecret: makeDeterministicMinter() },
    });
    assert.ok(built);
    // The header should carry the split-derived 0.3 secret, not the original 1.0.
    assert.ok(built!.secret.startsWith("e0.3:secret:"));
    // Change should be in the wallet.
    assert.ok((await wallet.list()).some((s) => s.startsWith("e0.7:secret:")));
  } finally {
    restore();
    await issuer.close();
  }
});

test("wrapFetchWithWebcash with autoSplit pays a 402 by splitting a larger secret", async () => {
  const issuer = await startFakeIssuer("success");
  const restore = silenceStderr();

  // Fake resource server: returns 402 unless X-PAYMENT is present.
  const resource = express();
  resource.get("/premium", (req, res) => {
    if (!req.header("X-PAYMENT")) {
      res.status(402).json({
        x402Version: 2,
        error: "X-PAYMENT header is required",
        resource: { url: "http://x/premium" },
        accepts: [
          {
            scheme: WEBCASH_SCHEME,
            network: "webcash:mainnet",
            amount: "30000000",
            asset: "webcash",
            payTo: issuer.url,
            maxTimeoutSeconds: 60,
          },
        ],
      } satisfies PaymentRequired);
      return;
    }
    res.json({ ok: true });
  });
  const resourceServer = await new Promise<{ url: string; close: () => Promise<void> }>((resolveStart) => {
    const s = resource.listen(0, () => {
      const addr = s.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolveStart({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });

  const wallet = new MemoryWallet([SECRET_1_0]);
  const pay = wrapFetchWithWebcash(fetch, {
    wallet,
    autoSplit: { mintOutputSecret: makeDeterministicMinter() },
  });

  try {
    const res = await pay(`${resourceServer.url}/premium`);
    assert.equal(res.status, 200);
    // 1.0 secret should be split; wallet should now hold the 0.7 change.
    const remaining = await wallet.list();
    assert.ok(!remaining.includes(SECRET_1_0));
    assert.ok(remaining.some((s) => s.startsWith("e0.7:secret:")));
    // Issuer was called exactly once (the split, not a settlement).
    assert.equal(issuer.calls.length, 1);
  } finally {
    restore();
    await resourceServer.close();
    await issuer.close();
  }
});
