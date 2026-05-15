// Recipient binding — buyer-derived output secrets for the webcash scheme.
//
// Background:
//
// In the baseline x402-webcash flow, the facilitator mints the output secret
// that the resource server will hold after settlement. That puts the
// facilitator in a position to substitute its own output: it can call
// /replace with a secret only IT knows, returning success to the resource
// server with a secret IT controls, and pocket the funds. The mitigations
// today are (a) self-host the facilitator (paywallLocal closes this), or
// (b) trust the facilitator operationally.
//
// Recipient binding is a third option that works WITH a third-party
// facilitator. The protocol:
//
// 1. Resource server publishes an ephemeral X25519 public key + nonce in
//    the 402 challenge (`extra.recipientPublicKey`, `extra.recipientNonce`).
// 2. Buyer generates an ephemeral X25519 key pair, performs ECDH against
//    the server's public key, and derives the OUTPUT secret hex via HKDF
//    over the shared secret, bound to nonce + amount:
//      info = "x402-webcash:v1:" + nonce + ":" + amountDecimal
//      output_hex = HKDF-SHA256(ecdh, salt=nonce, info=info, L=32)
//    output_secret = "e<amountDecimal>:secret:<output_hex>"
// 3. Buyer sends:
//      payload.secret        = buyer's input secret (as today)
//      payload.outputSecret  = the derived output secret
//      payload.buyerPublicKey = buyer's ephemeral public key (base64)
//      accepted.extra.recipientPublicHash = sha256(output_secret_string) (base64)
// 4. Facilitator (when recipientPublicHash is set):
//      - verifies sha256(payload.outputSecret) == recipientPublicHash
//      - calls /replace(input=payload.secret, output=payload.outputSecret)
//      - never mints its own output
// 5. Resource server (after settlement):
//      - re-derives the expected output secret from its private key +
//        payload.buyerPublicKey + nonce + amountDecimal
//      - verifies it matches `settled.extensions.webcashOutput.secret`
//
// Trust gained: the facilitator is constrained to use a specific output
// secret it cannot choose. A malicious facilitator that substitutes a
// different output produces a SettlementResponse whose webcashOutput.secret
// (a) does not hash to recipientPublicHash and (b) does not match the
// server's re-derivation — both anomalies are detected and the request
// fails 500 with a CRITICAL log.
//
// Residual risk (race window):
//
// The facilitator briefly knows `payload.outputSecret` (it MUST, in order
// to call /replace). Between /replace returning and the resource server
// refreshing the secret into its own wallet, the facilitator could race
// to spend the secret first. Mitigations: (a) the resource server's
// onSettled refreshes immediately, (b) deploy facilitators with low
// network distance to your wallet's refresh path, (c) use paywallLocal
// when the race window is unacceptable.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const HKDF_INFO_PREFIX = "x402-webcash:v1:";
const SECRET_HEX_BYTES = 32;
const X25519_RAW_BYTES = 32;

/**
 * Derive the bound output secret for a given (recipient pubkey, nonce,
 * amount) tuple from one side of an ECDH exchange. The function is
 * symmetric — buyer and recipient compute the same value with their own
 * key as `localPrivate` and the other party's as `remotePublic`.
 *
 * Returns the canonical webcash secret string `e<amountDecimal>:secret:<hex>`.
 */
function deriveBoundOutputSecret(
  localPrivate: KeyObject,
  remotePublic: KeyObject,
  nonce: string,
  amountDecimal: string,
): string {
  if (!nonce || typeof nonce !== "string") {
    throw new TypeError("deriveBoundOutputSecret: nonce must be a non-empty string");
  }
  if (!amountDecimal || typeof amountDecimal !== "string") {
    throw new TypeError(
      "deriveBoundOutputSecret: amountDecimal must be a non-empty string",
    );
  }
  const shared = diffieHellman({ privateKey: localPrivate, publicKey: remotePublic });
  // Nonce binds to the specific challenge; info binds to the amount and
  // protocol version. Salt = nonce keeps HKDF's extract step domain-separated
  // across requests even if the same key pair is reused across challenges.
  const salt = Buffer.from(nonce, "utf8");
  const info = Buffer.from(`${HKDF_INFO_PREFIX}${nonce}:${amountDecimal}`, "utf8");
  const hexBytes = Buffer.from(hkdfSync("sha256", shared, salt, info, SECRET_HEX_BYTES));
  return `e${amountDecimal}:secret:${hexBytes.toString("hex")}`;
}

/** Public hash that goes in `accepted.extra.recipientPublicHash`. */
export function recipientPublicHash(outputSecret: string): string {
  return createHash("sha256").update(outputSecret, "utf8").digest("base64");
}

function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== X25519_RAW_BYTES) {
    throw new Error(
      `[x402-webcash] X25519 public key must be ${X25519_RAW_BYTES} raw bytes, got ${raw.length}`,
    );
  }
  // Wrap raw 32-byte X25519 key in the standard SPKI DER prefix so Node's
  // createPublicKey accepts it. The 12-byte prefix encodes:
  //   SEQUENCE(SEQUENCE(OID id-X25519)) BIT STRING(raw key)
  const spkiPrefix = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
  ]);
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKeyBase64(key: KeyObject): string {
  // SPKI DER for X25519 is exactly 44 bytes; the last 32 are the raw key.
  const spki = key.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - X25519_RAW_BYTES)).toString("base64");
}

// ---------------------------------------------------------------------------
// Buyer-side: derive an output secret to send to the seller.
// ---------------------------------------------------------------------------

export type BuyerBoundOutput = {
  /** Output secret string to put in `paymentPayload.payload.outputSecret`. */
  outputSecret: string;
  /** SHA-256 hash for `accepted.extra.recipientPublicHash`. */
  recipientPublicHash: string;
  /** Buyer's ephemeral public key (raw, base64) for `payload.buyerPublicKey`. */
  buyerPublicKey: string;
};

/**
 * Buyer-side helper. Given a 402 challenge that advertises a recipient
 * public key and nonce, generate a fresh ephemeral X25519 key pair, derive
 * the bound output secret, and return everything the buyer needs to send.
 *
 * The buyer's ephemeral private key is discarded after this call — it has
 * no use beyond this single derivation, and shouldn't be retained.
 */
export function buildBoundOutput(opts: {
  recipientPublicKey: string;
  recipientNonce: string;
  amountDecimal: string;
}): BuyerBoundOutput {
  const recipientPub = publicKeyFromBase64(opts.recipientPublicKey);
  const { privateKey: buyerPriv, publicKey: buyerPub } = generateKeyPairSync("x25519");
  const outputSecret = deriveBoundOutputSecret(
    buyerPriv,
    recipientPub,
    opts.recipientNonce,
    opts.amountDecimal,
  );
  return {
    outputSecret,
    recipientPublicHash: recipientPublicHash(outputSecret),
    buyerPublicKey: rawPublicKeyBase64(buyerPub),
  };
}

// ---------------------------------------------------------------------------
// Recipient-side: RecipientKey class that owns the long-lived private key.
// ---------------------------------------------------------------------------

/**
 * A recipient's X25519 key pair, used to bind output secrets to a specific
 * resource server. Resource servers SHOULD generate one of these per
 * paywall instance (or per process) and reuse it across requests. Rotating
 * the key invalidates any outstanding 402 challenges that referenced the
 * old public key — that's fine for ephemeral, short-lived challenges.
 *
 * The private key never leaves this object. It is held in a Node KeyObject
 * which is not directly serializable; if you must persist across restarts,
 * export via `exportPrivateKeyJwk()` and re-import via `importPrivateKeyJwk()`.
 */
export class RecipientKey {
  readonly publicKeyBase64: string;

  constructor(private readonly privateKey: KeyObject, private readonly publicKey: KeyObject) {
    this.publicKeyBase64 = rawPublicKeyBase64(publicKey);
  }

  /** Generate a fresh ephemeral X25519 key pair. */
  static generate(): RecipientKey {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    return new RecipientKey(privateKey, publicKey);
  }

  /**
   * Re-import a previously exported private key. The JWK is the standard
   * X25519 OKP form `{kty:"OKP",crv:"X25519",d,x}`.
   */
  static fromJwk(jwk: { kty: "OKP"; crv: "X25519"; d: string; x: string }): RecipientKey {
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    const publicKey = createPublicKey(privateKey);
    return new RecipientKey(privateKey, publicKey);
  }

  /**
   * Generate a fresh per-challenge nonce. Resource servers MUST use a fresh
   * nonce for every 402 — reusing nonces lets two distinct challenges share
   * the same derived output secret, defeating per-transaction binding.
   */
  static newNonce(): string {
    return randomBytes(16).toString("base64url");
  }

  /** Export the private key as a JWK (for persistence across restarts). */
  exportPrivateKeyJwk(): { kty: "OKP"; crv: "X25519"; d: string; x: string } {
    return this.privateKey.export({ format: "jwk" }) as {
      kty: "OKP";
      crv: "X25519";
      d: string;
      x: string;
    };
  }

  /**
   * Server-side derivation. Given a buyer's ephemeral public key + nonce
   * + amount, re-derive the output secret that the buyer should have used.
   * Used by the paywall middleware to verify post-settlement that the
   * facilitator returned the right secret.
   */
  deriveExpectedOutputSecret(
    buyerPublicKey: string,
    nonce: string,
    amountDecimal: string,
  ): string {
    const buyerPub = publicKeyFromBase64(buyerPublicKey);
    return deriveBoundOutputSecret(this.privateKey, buyerPub, nonce, amountDecimal);
  }

  /**
   * Verify that `claimedSecret` is what the buyer would have derived.
   * Constant-time comparison on the hex tail so timing leaks don't reveal
   * which prefix matched. Returns true on match.
   */
  verifyOutputSecret(
    buyerPublicKey: string,
    nonce: string,
    amountDecimal: string,
    claimedSecret: string,
  ): boolean {
    const expected = this.deriveExpectedOutputSecret(buyerPublicKey, nonce, amountDecimal);
    return timingSafeEqualStrings(expected, claimedSecret);
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
