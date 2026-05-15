// Recipient-binding tests.
//
// Three layers:
//   1. Pure crypto round-trip (buyer derives, recipient verifies).
//   2. Facilitator-level enforcement (binding hash mismatch → rejection,
//      no outputSecret → rejection, wrong amount → rejection).
//   3. End-to-end via paywallLocal (server publishes 402 with binding,
//      buyer derives via buildWebcashHeader, server verifies the returned
//      output secret against its private key).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import express from "express";
import http from "node:http";
import { Facilitator } from "../src/facilitator.js";
import { paywallLocal, type WebcashOutput } from "../src/middleware.js";
import {
  buildBoundOutput,
  RecipientKey,
  recipientPublicHash,
} from "../src/recipient.js";
import {
  buildWebcashHeader,
  MemoryWallet,
} from "../src/client/index.js";
import type {
  FacilitatorRequest,
  PaymentRequired,
  SettlementResponse,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// 1. Pure crypto round-trip
// ---------------------------------------------------------------------------

test("RecipientKey: buyer's buildBoundOutput and recipient's verify agree", () => {
  const recipient = RecipientKey.generate();
  const nonce = RecipientKey.newNonce();
  const built = buildBoundOutput({
    recipientPublicKey: recipient.publicKeyBase64,
    recipientNonce: nonce,
    amountDecimal: "0.3",
  });
  // Hash of the secret matches the precommitment.
  assert.equal(recipientPublicHash(built.outputSecret), built.recipientPublicHash);
  // Recipient can re-derive the same secret given the buyer's pubkey + nonce + amount.
  const expected = recipient.deriveExpectedOutputSecret(built.buyerPublicKey, nonce, "0.3");
  assert.equal(expected, built.outputSecret);
  // verifyOutputSecret returns true for the matching tuple.
  assert.equal(
    recipient.verifyOutputSecret(built.buyerPublicKey, nonce, "0.3", built.outputSecret),
    true,
  );
});

test("RecipientKey.verifyOutputSecret rejects a tampered secret", () => {
  const recipient = RecipientKey.generate();
  const nonce = RecipientKey.newNonce();
  const built = buildBoundOutput({
    recipientPublicKey: recipient.publicKeyBase64,
    recipientNonce: nonce,
    amountDecimal: "0.3",
  });
  const tampered = "e0.3:secret:" + "00".repeat(32);
  assert.equal(
    recipient.verifyOutputSecret(built.buyerPublicKey, nonce, "0.3", tampered),
    false,
  );
});

test("RecipientKey.verifyOutputSecret rejects when the nonce is wrong", () => {
  const recipient = RecipientKey.generate();
  const nonce = RecipientKey.newNonce();
  const built = buildBoundOutput({
    recipientPublicKey: recipient.publicKeyBase64,
    recipientNonce: nonce,
    amountDecimal: "0.3",
  });
  // Using a different nonce changes the HKDF context — the derived secret
  // differs, so verification must fail.
  const wrongNonce = RecipientKey.newNonce();
  assert.equal(
    recipient.verifyOutputSecret(built.buyerPublicKey, wrongNonce, "0.3", built.outputSecret),
    false,
  );
});

test("RecipientKey.verifyOutputSecret rejects when the amount is wrong", () => {
  // Critical for the amount-substitution attack: an attacker cannot reuse
  // a secret derived for amount A as the output of a settlement at amount B.
  const recipient = RecipientKey.generate();
  const nonce = RecipientKey.newNonce();
  const built = buildBoundOutput({
    recipientPublicKey: recipient.publicKeyBase64,
    recipientNonce: nonce,
    amountDecimal: "0.3",
  });
  assert.equal(
    recipient.verifyOutputSecret(built.buyerPublicKey, nonce, "0.1", built.outputSecret),
    false,
  );
});

test("RecipientKey.fromJwk round-trips the private key across export/import", () => {
  const original = RecipientKey.generate();
  const jwk = original.exportPrivateKeyJwk();
  const restored = RecipientKey.fromJwk(jwk);
  assert.equal(restored.publicKeyBase64, original.publicKeyBase64);
  // Both must derive the same output for the same inputs.
  const nonce = RecipientKey.newNonce();
  const built = buildBoundOutput({
    recipientPublicKey: original.publicKeyBase64,
    recipientNonce: nonce,
    amountDecimal: "1",
  });
  assert.equal(
    restored.deriveExpectedOutputSecret(built.buyerPublicKey, nonce, "1"),
    built.outputSecret,
  );
});

test("buildBoundOutput: two calls with the same inputs produce DIFFERENT outputs (buyer keypair is ephemeral per call)", () => {
  // Replay safety: the buyer's ephemeral key changes per call, so even an
  // attacker observing two challenges with the same recipient pubkey +
  // nonce + amount sees two distinct secrets.
  const recipient = RecipientKey.generate();
  const a = buildBoundOutput({
    recipientPublicKey: recipient.publicKeyBase64,
    recipientNonce: "same-nonce",
    amountDecimal: "0.3",
  });
  const b = buildBoundOutput({
    recipientPublicKey: recipient.publicKeyBase64,
    recipientNonce: "same-nonce",
    amountDecimal: "0.3",
  });
  assert.notEqual(a.outputSecret, b.outputSecret);
  assert.notEqual(a.buyerPublicKey, b.buyerPublicKey);
});

// ---------------------------------------------------------------------------
// 2. Facilitator-level enforcement
// ---------------------------------------------------------------------------

function makeRequest(opts: {
  buyerSecret: string;
  outputSecret?: string;
  recipientPublicHash?: string;
  buyerPublicKey?: string;
}): FacilitatorRequest {
  const requirements = {
    scheme: "webcash" as const,
    network: "webcash:mainnet" as const,
    amount: "30000000",
    asset: "webcash" as const,
    payTo: "https://webcash.org",
    maxTimeoutSeconds: 60,
  };
  return {
    x402Version: 2 as const,
    paymentPayload: {
      x402Version: 2 as const,
      accepted: {
        ...requirements,
        ...(opts.recipientPublicHash
          ? { extra: { recipientPublicHash: opts.recipientPublicHash } }
          : {}),
      },
      payload: {
        secret: opts.buyerSecret,
        ...(opts.outputSecret ? { outputSecret: opts.outputSecret } : {}),
        ...(opts.buyerPublicKey ? { buyerPublicKey: opts.buyerPublicKey } : {}),
      },
    },
    paymentRequirements: requirements,
  };
}

test("facilitator: rejects bound request when payload.outputSecret is missing", async () => {
  // Replace fetch so we never hit a real issuer — settlement should fail
  // validation before reaching the network.
  const fac = new Facilitator({
    issuerAllowlist: ["https://webcash.org"],
    fetchImpl: async () => new Response("{}", { status: 500 }),
  });
  const r = makeRequest({
    buyerSecret: "e0.3:secret:" + "aa".repeat(32),
    recipientPublicHash: "any-hash=",
    // outputSecret intentionally omitted
  });
  const result = await fac.settle(r);
  assert.equal(result.success, false);
  assert.match(result.errorReason ?? "", /payload\.outputSecret is missing/);
});

test("facilitator: rejects bound request when sha256(outputSecret) does not match the precommitment", async () => {
  const fac = new Facilitator({
    issuerAllowlist: ["https://webcash.org"],
    fetchImpl: async () => new Response("{}", { status: 500 }),
  });
  const buyerSecret = "e0.3:secret:" + "aa".repeat(32);
  const claimedOutput = "e0.3:secret:" + "bb".repeat(32);
  const r = makeRequest({
    buyerSecret,
    outputSecret: claimedOutput,
    recipientPublicHash: "wrong-hash=",
  });
  const result = await fac.settle(r);
  assert.equal(result.success, false);
  assert.match(result.errorReason ?? "", /recipientPublicHash mismatch/);
});

test("facilitator: rejects bound request when outputSecret amount disagrees with input amount", async () => {
  const fac = new Facilitator({
    issuerAllowlist: ["https://webcash.org"],
    fetchImpl: async () => new Response("{}", { status: 500 }),
  });
  const buyerSecret = "e0.3:secret:" + "aa".repeat(32);
  // Mint an output for a smaller amount with a matching hash.
  const wrongAmountOutput = "e0.1:secret:" + "bb".repeat(32);
  const hash = recipientPublicHash(wrongAmountOutput);
  const r = makeRequest({
    buyerSecret,
    outputSecret: wrongAmountOutput,
    recipientPublicHash: hash,
  });
  const result = await fac.settle(r);
  assert.equal(result.success, false);
  assert.match(result.errorReason ?? "", /outputSecret amount does not match/);
});

test("facilitator: uses buyer-supplied outputSecret instead of minting when binding is valid", async () => {
  let issuerCalledWithOutputs: string[] = [];
  // Simulate a successful issuer /replace.
  const fac = new Facilitator({
    issuerAllowlist: ["https://webcash.org"],
    healthCacheTtlMs: 10_000,
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes("/health_check")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (u.includes("/replace")) {
        const body = JSON.parse(String((init as RequestInit).body));
        issuerCalledWithOutputs = body.new_webcashes;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    },
    mintOutputSecret: () => {
      throw new Error("mintOutputSecret should NOT be called when binding is on");
    },
  });
  const buyerSecret = "e0.3:secret:" + "aa".repeat(32);
  const output = "e0.3:secret:" + "cc".repeat(32);
  const hash = recipientPublicHash(output);
  const r = makeRequest({
    buyerSecret,
    outputSecret: output,
    recipientPublicHash: hash,
  });
  const result = await fac.settle(r);
  assert.equal(result.success, true, `unexpected: ${result.errorReason}`);
  assert.deepEqual(issuerCalledWithOutputs, [output]);
  const surfaced = (result.extensions as { webcashOutput?: WebcashOutput } | undefined)
    ?.webcashOutput;
  assert.equal(surfaced?.secret, output);
});

// ---------------------------------------------------------------------------
// 3. End-to-end via paywallLocal + buildWebcashHeader
// ---------------------------------------------------------------------------

test("end-to-end: paywallLocal with recipientKey rejects when facilitator substitutes a different output", async () => {
  // Simulate an in-process facilitator that ignores the binding and mints
  // its own output. The middleware's binding verification MUST catch it.
  const recipient = RecipientKey.generate();
  let capturedNonce: string | null = null;

  // A "malicious" facilitator that ignores payload.outputSecret and returns
  // its own. We build this directly because paywallLocal won't normally
  // produce a substituted response when used with a faithful Facilitator.
  const maliciousFacilitator = {
    settle: async (req: FacilitatorRequest): Promise<SettlementResponse> => {
      const nonceFromReq = (
        req.paymentRequirements.extra as { recipientNonce?: string } | undefined
      )?.recipientNonce;
      capturedNonce = nonceFromReq ?? null;
      return {
        success: true,
        transaction: "t1",
        network: "webcash:mainnet",
        amount: "30000000",
        extensions: {
          webcashOutput: {
            secret: "e0.3:secret:" + "ff".repeat(32), // attacker-controlled
            amountDecimal: "0.3",
            amountWats: "30000000",
          },
        },
      };
    },
  };

  const app = express();
  app.get(
    "/premium",
    paywallLocal(maliciousFacilitator as unknown as Facilitator, {
      amountWats: 30_000_000n,
      recipientKey: recipient,
      // Provide an onSettled so we'd notice if we incorrectly succeeded.
      onSettled: () => {
        throw new Error("onSettled MUST NOT be invoked on binding mismatch");
      },
    }),
    (_req, res) => res.json({ ok: true }),
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    const url = `http://127.0.0.1:${addr.port}/premium`;

    // First request: get the 402 to learn the recipient pubkey + nonce.
    const probe = await new Promise<{ status: number; body: PaymentRequired }>((resolve) => {
      http.get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }),
        );
      });
    });
    assert.equal(probe.status, 402);
    const requirements = probe.body.accepts[0];
    assert.equal(
      typeof (requirements.extra as { recipientPublicKey?: unknown }).recipientPublicKey,
      "string",
      "402 must advertise recipientPublicKey",
    );

    // Build payment via the client-side helper (which auto-derives).
    const wallet = new MemoryWallet(["e0.3:secret:" + "11".repeat(32)]);
    const built = await buildWebcashHeader(probe.body, wallet);
    assert.ok(built, "header must build for webcash scheme");

    // Send the retry; the middleware should detect the substituted output
    // and respond 500 with binding_verification_failure.
    const retry = await new Promise<{ status: number; body: { error?: string } }>(
      (resolve, reject) => {
        const u = new URL(url);
        const req = http.request(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: "GET",
            headers: { "X-PAYMENT": built.header },
          },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: data ? JSON.parse(data) : {},
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(retry.status, 500);
    assert.equal(retry.body.error, "binding_verification_failure");
    assert.ok(capturedNonce, "facilitator should have seen a recipientNonce");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("end-to-end: paywallLocal with recipientKey + honest facilitator round-trips successfully", async () => {
  const recipient = RecipientKey.generate();

  // Honest facilitator: uses the buyer-supplied output secret.
  const honestFacilitator = {
    settle: async (req: FacilitatorRequest): Promise<SettlementResponse> => {
      const out = (req.paymentPayload.payload as { outputSecret?: string }).outputSecret;
      if (!out) {
        return {
          success: false,
          errorReason: "test: outputSecret missing",
          transaction: "",
          network: "webcash:mainnet",
        };
      }
      return {
        success: true,
        transaction: "t-honest",
        network: "webcash:mainnet",
        amount: "30000000",
        extensions: {
          webcashOutput: {
            secret: out,
            amountDecimal: "0.3",
            amountWats: "30000000",
          },
        },
      };
    },
  };

  let persisted: WebcashOutput | null = null;
  const app = express();
  app.get(
    "/premium",
    paywallLocal(honestFacilitator as unknown as Facilitator, {
      amountWats: 30_000_000n,
      recipientKey: recipient,
      onSettled: (o) => {
        persisted = o;
      },
    }),
    (_req, res) => res.json({ ok: true }),
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no address");
    const url = `http://127.0.0.1:${addr.port}/premium`;

    const probe = await new Promise<{ status: number; body: PaymentRequired }>((resolve) => {
      http.get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }),
        );
      });
    });
    const wallet = new MemoryWallet(["e0.3:secret:" + "11".repeat(32)]);
    const built = await buildWebcashHeader(probe.body, wallet);
    assert.ok(built);

    const retry = await new Promise<{ status: number }>((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "GET",
          headers: { "X-PAYMENT": built.header },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(retry.status, 200);
    // The onSettled hook fired with the bound secret.
    const out = persisted as WebcashOutput | null;
    assert.ok(out, "onSettled should have received the output");
    // The persisted secret must be the buyer-derived one — verify via the
    // recipient key.
    const requirements = probe.body.accepts[0];
    const nonce = (requirements.extra as { recipientNonce: string }).recipientNonce;
    const buyerPub = (
      JSON.parse(Buffer.from(built.header, "base64").toString("utf8")).payload as {
        buyerPublicKey: string;
      }
    ).buyerPublicKey;
    assert.equal(
      recipient.verifyOutputSecret(buyerPub, nonce, "0.3", (out as WebcashOutput).secret),
      true,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
