// SPKI certificate pinning for x402-webcash fetch calls.
//
// Plain HTTPS protects against a passive on-path attacker, but the public CA
// system still gives any one of ~hundreds of CAs the ability to mint a cert
// for any hostname. Webcash secrets are bearer tokens — anyone holding the
// string can spend them — so a mis-issued cert on the facilitator↔issuer
// channel is an immediate loss. Pinning the issuer's SubjectPublicKeyInfo
// (SPKI) closes that hole: even a rogue CA cannot pass the additional pin
// check, because the public key it would have to forge is the legitimate
// server's, not the attacker's.
//
// Pin format follows RFC 7469: base64(SHA-256(DER-encoded SubjectPublicKeyInfo)).
// You can compute a server's pin in a few ways, all equivalent:
//
//   openssl s_client -connect webcash.org:443 < /dev/null 2>/dev/null \
//     | openssl x509 -pubkey -noout \
//     | openssl pkey -pubin -outform DER \
//     | openssl dgst -sha256 -binary | base64
//
//   # or, from a stored .pem cert:
//   openssl x509 -in cert.pem -pubkey -noout \
//     | openssl pkey -pubin -outform DER \
//     | openssl dgst -sha256 -binary | base64
//
// Pinning is ADDITIVE: default CA + hostname validation runs first; the pin
// is an extra check on top. Set `pinnedSpkiHashes` to at least two values
// (current + backup) so a planned key rotation is not a service outage.

import { Agent, type Dispatcher } from "undici";
import { createHash, X509Certificate } from "node:crypto";
import * as tls from "node:tls";

/** Thrown when the TLS server's SPKI hash matches none of the configured pins. */
export class PinMismatchError extends Error {
  override readonly name = "PinMismatchError";
  constructor(
    readonly host: string,
    readonly expected: readonly string[],
    readonly actual: string,
  ) {
    super(
      `[x402-webcash] SPKI pin mismatch for ${host}: expected one of ` +
        `[${expected.join(", ")}], got ${actual}. The TLS server's public key ` +
        `does not match any pinned hash — refusing to transmit any bearer ` +
        `secret. A wrong pin means either (a) the pin list is stale (rotate ` +
        `the pin) or (b) the connection is being MITM'd by a CA-mis-issued ` +
        `cert.`,
    );
  }
}

/**
 * Compute the RFC 7469 SPKI pin (`base64(SHA-256(SPKI DER))`) for a given
 * SubjectPublicKeyInfo. Use this in tests and pin-discovery tooling.
 */
export function spkiSha256(spkiDer: Buffer | Uint8Array): string {
  return createHash("sha256").update(spkiDer).digest("base64");
}

/**
 * The pin-verification callback, factored out so it is unit-testable without
 * a live TLS handshake. Returns `undefined` on success, an Error on failure.
 *
 * Runs the default identity check first (do NOT weaken CA/hostname validation
 * — pinning is additive). Then verifies the cert's SPKI against the pin list.
 */
export function checkPinnedIdentity(
  hostname: string,
  cert: tls.PeerCertificate,
  pins: readonly string[],
  defaultCheck: (h: string, c: tls.PeerCertificate) => Error | undefined = tls.checkServerIdentity,
): Error | undefined {
  const defaultErr = defaultCheck(hostname, cert);
  if (defaultErr) return defaultErr;
  // Node's `cert.pubkey` is the raw public key bytes (DER-encoded RSA/EC
  // key WITHOUT the SubjectPublicKeyInfo algorithm-identifier wrapper).
  // RFC 7469 pins hash the FULL SPKI, which is what `openssl x509 -pubkey`
  // produces. To match, we re-parse the raw cert via X509Certificate and
  // export the public key in SPKI DER form.
  const raw = (cert as { raw?: Buffer }).raw;
  if (!raw || raw.length === 0) {
    return new Error(
      `[x402-webcash] cert.raw missing for ${hostname}; cannot verify SPKI ` +
        `pin. Failing closed.`,
    );
  }
  let spkiDer: Buffer;
  try {
    const x509 = new X509Certificate(raw);
    spkiDer = Buffer.from(x509.publicKey.export({ type: "spki", format: "der" }));
  } catch (e) {
    return new Error(
      `[x402-webcash] failed to parse SPKI from peer cert for ${hostname}: ` +
        `${(e as Error).message}. Failing closed.`,
    );
  }
  const actual = spkiSha256(spkiDer);
  if (!pins.includes(actual)) {
    return new PinMismatchError(hostname, pins, actual);
  }
  return undefined;
}

export type PinningOptions = {
  /** Additional trusted CAs (PEM or DER), merged with the system trust store. */
  ca?: string | Buffer | ReadonlyArray<string | Buffer>;
};

/**
 * Build an undici Dispatcher whose TLS handshakes are pin-checked. Exposed
 * separately from `createPinnedFetch` so callers who use undici directly
 * (Pool, Client, request) can apply the same pin without going through fetch.
 *
 * Pass `ca` to add private/self-signed CAs to the trust store for this
 * dispatcher (default CA + hostname validation still runs; pinning is on top).
 */
export function createPinnedDispatcher(
  pins: readonly string[],
  options: PinningOptions = {},
): Dispatcher {
  if (pins.length === 0) {
    throw new Error("createPinnedDispatcher: pins must be non-empty");
  }
  const frozen = [...pins];
  // undici's Agent.connect type omits `ca`; it is forwarded to tls.connect.
  const connect: Record<string, unknown> = {
    checkServerIdentity: (hostname: string, cert: tls.PeerCertificate) =>
      checkPinnedIdentity(hostname, cert, frozen),
  };
  if (options.ca !== undefined) connect.ca = options.ca;
  return new Agent({ connect } as ConstructorParameters<typeof Agent>[0]);
}

/**
 * Wrap a `fetch` so every request it makes pins the server's SPKI to one of
 * `pinnedSpkiHashes`. If `baseFetch` is omitted, the global `fetch` is used.
 *
 * The returned function has the same signature as `fetch`. Mismatched pins
 * surface as a fetch-level TypeError whose `cause` chain contains
 * `PinMismatchError` (undici wraps connection errors).
 */
export function createPinnedFetch(opts: {
  pinnedSpkiHashes: readonly string[];
  baseFetch?: typeof fetch;
  /** Additional trusted CAs (PEM or DER) — see PinningOptions.ca. */
  ca?: PinningOptions["ca"];
}): typeof fetch {
  const dispatcher = createPinnedDispatcher(opts.pinnedSpkiHashes, { ca: opts.ca });
  const baseFetch = opts.baseFetch ?? fetch;
  // undici's fetch reads `dispatcher` from init even though it's not in the
  // standard RequestInit type. Cast through unknown to keep the public
  // signature WHATWG-compliant for consumers.
  const wrapped: typeof fetch = (input, init) =>
    baseFetch(input, { ...(init ?? {}), dispatcher } as RequestInit & {
      dispatcher: Dispatcher;
    });
  return wrapped;
}
