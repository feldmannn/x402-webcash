// Tests for SPKI cert pinning.
//
// Two layers of coverage:
//
// 1. Unit tests over the verification predicate `checkPinnedIdentity` —
//    exercise every branch (match, mismatch, missing pubkey, default-check
//    failure, multi-pin OR semantics) without any TLS handshake.
//
// 2. End-to-end tests against a real HTTPS server using a self-signed cert
//    fixture — prove that the dispatcher is wired into fetch correctly and
//    that a mismatched pin aborts the TLS handshake before any request body
//    is transmitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import * as https from "node:https";
import * as tls from "node:tls";
import type { AddressInfo } from "node:net";

import {
  checkPinnedIdentity,
  createPinnedFetch,
  createPinnedDispatcher,
  Facilitator,
  paywall,
  PinMismatchError,
  spkiSha256,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture: self-signed cert + key + pre-computed SPKI pin
// ---------------------------------------------------------------------------
//
// Generated via:
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
//     -keyout key.pem -out cert.pem -days 36500 -nodes \
//     -subj "/CN=localhost" \
//     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
//   openssl x509 -in cert.pem -pubkey -noout \
//     | openssl pkey -pubin -outform DER \
//     | openssl dgst -sha256 -binary | base64
//
// Valid until ~year 2126. Self-signed; rejectUnauthorized:false in clients
// because we use the pin as the trust anchor for this test.

const FIXTURE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglc6RT5A8Y0/zBlkt
1VDVCizbIOnkwTN7VpY58DiMQw+hRANCAAQRxg5bDDSWe3y4Gpvx9crQAZfVOui2
puZPJWgM8j21gi24ze1P9unTclKXYqx6/gFu42j0C9loIbx7DrNzNl44
-----END PRIVATE KEY-----
`;

const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUewCpXs1YwyhSlAXbkAITk+QyjJ8wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDUxNTIxNDkyNVoYDzIxMjYwNDIx
MjE0OTI1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQRxg5bDDSWe3y4Gpvx9crQAZfVOui2puZPJWgM8j21gi24ze1P9unT
clKXYqx6/gFu42j0C9loIbx7DrNzNl44o28wbTAdBgNVHQ4EFgQU+95xbKs166jV
HRtf08ZUxLY1nuAwHwYDVR0jBBgwFoAU+95xbKs166jVHRtf08ZUxLY1nuAwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAPi0Z3fjkclYgxKkzEjlyqu+T3o4EXubSA9bg5xXNgjOAiAy
s940EZxuldhwjQaJK8UQK1QDg+LN/YjSDrXgT+d0cA==
-----END CERTIFICATE-----
`;

const FIXTURE_PIN = "NWny299lvjd0rPs5z5gb8Vq5tyjlt6vn5C4N6MF4Ltg=";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The fixture cert as a Buffer of DER bytes (the form `cert.raw` takes in
 * Node's PeerCertificate). Used to drive `checkPinnedIdentity` directly.
 */
const FIXTURE_CERT_RAW: Buffer = Buffer.from(new X509Certificate(FIXTURE_CERT_PEM).raw);

function fakeCert(raw: Buffer | undefined): tls.PeerCertificate {
  return { raw } as unknown as tls.PeerCertificate;
}

/**
 * Spin up a localhost HTTPS server using the fixture cert. Returns the URL
 * and a close function. The server echoes the request path back as JSON.
 */
async function startHttpsServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = https.createServer(
    { key: FIXTURE_KEY_PEM, cert: FIXTURE_CERT_PEM },
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://localhost:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// spkiSha256: pure function
// ---------------------------------------------------------------------------

test("spkiSha256 returns RFC-7469-format pin for a known SPKI", () => {
  const spki = Buffer.from("00112233445566778899aabbccddeeff".repeat(2), "hex");
  const expected = createHash("sha256").update(spki).digest("base64");
  assert.equal(spkiSha256(spki), expected);
});

// ---------------------------------------------------------------------------
// checkPinnedIdentity: unit tests over the verification predicate
// ---------------------------------------------------------------------------

test("checkPinnedIdentity returns undefined when pin matches and default check passes", () => {
  const result = checkPinnedIdentity(
    "localhost",
    fakeCert(FIXTURE_CERT_RAW),
    [FIXTURE_PIN],
    () => undefined,
  );
  assert.equal(result, undefined);
});

test("checkPinnedIdentity returns PinMismatchError when SPKI hash is not in the pin list", () => {
  const result = checkPinnedIdentity(
    "localhost",
    fakeCert(FIXTURE_CERT_RAW),
    ["not-the-real-pin="],
    () => undefined,
  );
  assert.ok(result instanceof PinMismatchError);
  assert.equal(result.host, "localhost");
  assert.equal(result.expected.length, 1);
  assert.equal(result.actual, FIXTURE_PIN);
});

test("checkPinnedIdentity fails closed when cert.raw is missing", () => {
  const result = checkPinnedIdentity(
    "example.com",
    fakeCert(undefined),
    ["any-pin="],
    () => undefined,
  );
  assert.ok(result instanceof Error);
  assert.match(result.message, /cert\.raw missing/);
});

test("checkPinnedIdentity propagates default-check failure without computing pin", () => {
  // Pinning is additive — hostname/CA failures from the default check MUST
  // bubble up even if the pin would match.
  const defaultErr = new Error("default check says no");
  const result = checkPinnedIdentity(
    "example.com",
    fakeCert(FIXTURE_CERT_RAW),
    [FIXTURE_PIN],
    () => defaultErr,
  );
  assert.equal(result, defaultErr);
});

test("checkPinnedIdentity accepts when any one of multiple pins matches", () => {
  // Operators MUST configure backup pins for key rotation. Membership is OR.
  const result = checkPinnedIdentity(
    "localhost",
    fakeCert(FIXTURE_CERT_RAW),
    ["backup-pin-1=", FIXTURE_PIN, "backup-pin-2="],
    () => undefined,
  );
  assert.equal(result, undefined);
});

test("checkPinnedIdentity fails closed when raw bytes do not parse as a cert", () => {
  const result = checkPinnedIdentity(
    "example.com",
    fakeCert(Buffer.from("not a real cert")),
    ["any-pin="],
    () => undefined,
  );
  assert.ok(result instanceof Error);
  assert.match(result.message, /failed to parse SPKI/);
});

// ---------------------------------------------------------------------------
// Factory shape
// ---------------------------------------------------------------------------

test("createPinnedFetch throws when given an empty pin list", () => {
  assert.throws(
    () => createPinnedFetch({ pinnedSpkiHashes: [] }),
    /pins must be non-empty/,
  );
});

test("createPinnedDispatcher throws when given an empty pin list", () => {
  assert.throws(() => createPinnedDispatcher([]), /pins must be non-empty/);
});

// ---------------------------------------------------------------------------
// End-to-end: real TLS server with the fixture cert
// ---------------------------------------------------------------------------

test("createPinnedFetch: round-trips a request when the pin matches", async () => {
  const server = await startHttpsServer();
  try {
    // ca: extends the trust store with the fixture's self-signed cert so
    // default CA validation passes. Pinning then runs as the additional
    // check on top — exactly the real-world flow (public CA + extra pin).
    const pinnedFetch = createPinnedFetch({
      pinnedSpkiHashes: [FIXTURE_PIN],
      ca: FIXTURE_CERT_PEM,
    });
    const res = await pinnedFetch(`${server.url}/hello`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { path: string; method: string };
    assert.equal(body.path, "/hello");
    assert.equal(body.method, "GET");
  } finally {
    await server.close();
  }
});

test("createPinnedFetch: TLS handshake aborts when the pin does not match", async () => {
  const server = await startHttpsServer();
  try {
    const wrongPin = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const pinnedFetch = createPinnedFetch({
      pinnedSpkiHashes: [wrongPin],
      ca: FIXTURE_CERT_PEM, // make CA pass so we KNOW the pin check is what's failing
    });
    let caught: unknown;
    try {
      await pinnedFetch(`${server.url}/hello`);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected fetch to throw on pin mismatch");
    // undici surfaces the underlying TLS failure as a TypeError; the cause
    // chain contains our PinMismatchError.
    const chain: unknown[] = [];
    let cur: unknown = caught;
    while (cur && chain.length < 10) {
      chain.push(cur);
      cur = (cur as { cause?: unknown }).cause;
    }
    const hasPinMismatch = chain.some((e) => e instanceof PinMismatchError);
    assert.ok(
      hasPinMismatch,
      `expected a PinMismatchError somewhere in the cause chain, got:\n` +
        chain.map((e) => `  ${(e as Error)?.name}: ${(e as Error)?.message}`).join("\n"),
    );
  } finally {
    await server.close();
  }
});

test("createPinnedFetch: backup pin is accepted (key-rotation friendly)", async () => {
  const server = await startHttpsServer();
  try {
    const pinnedFetch = createPinnedFetch({
      pinnedSpkiHashes: [
        "BACKUPpinNOTtheREALpinAAAAAAAAAAAAAAAAAAAAA=",
        FIXTURE_PIN,
      ],
      ca: FIXTURE_CERT_PEM,
    });
    const res = await pinnedFetch(`${server.url}/x`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Integration: pinnedSpkiHashes + fetchImpl mutual exclusion
// ---------------------------------------------------------------------------

test("Facilitator: pinnedSpkiHashes and fetchImpl are mutually exclusive", () => {
  assert.throws(
    () =>
      new Facilitator({
        issuerAllowlist: ["https://webcash.org"],
        pinnedSpkiHashes: ["some-pin="],
        fetchImpl: fetch,
      }),
    /mutually exclusive/,
  );
});

test("Facilitator accepts a pinnedSpkiHashes array at construction", () => {
  const f = new Facilitator({
    issuerAllowlist: ["https://webcash.org"],
    pinnedSpkiHashes: ["pin-not-actually-tested-here="],
  });
  assert.ok(f.supported().kinds.length > 0);
});

test("paywall: pinnedSpkiHashes and fetchImpl are mutually exclusive", () => {
  assert.throws(
    () =>
      paywall({
        amountWats: 100n,
        facilitatorUrl: "https://facilitator.example",
        pinnedSpkiHashes: ["some-pin="],
        fetchImpl: fetch,
      }),
    /mutually exclusive/,
  );
});

test("paywall accepts a pinnedSpkiHashes array at construction", () => {
  const handler = paywall({
    amountWats: 100n,
    facilitatorUrl: "https://facilitator.example",
    pinnedSpkiHashes: ["pin-not-actually-tested-here="],
  });
  assert.equal(typeof handler, "function");
});
