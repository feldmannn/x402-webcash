// Webcash x402 facilitator: implements verify, settle, supported.

import {
  FacilitatorRequest,
  PaymentRequirements,
  SettlementResponse,
  SupportedResponse,
  VerifyResponse,
  WebcashPayload,
} from "./types.js";
import {
  DEFAULT_ISSUER_TIMEOUT_MS,
  DEFAULT_LEGALESE,
  KNOWN_NETWORKS,
  ParsedSecret,
  issuerHealth,
  newOutputSecret,
  parseSecret,
  replaceSecret,
  secretFingerprint,
  watsToDecimal,
} from "./webcash.js";
import { createPinnedFetch } from "./pinning.js";
import { recipientPublicHash } from "./recipient.js";

export type FacilitatorOptions = {
  issuerAllowlist?: string[];
  fetchImpl?: typeof fetch;
  /**
   * Mints the output secret that the resource server will own after settlement.
   * The default uses cryptographically random bytes; the resulting secret is
   * surfaced via SettlementResponse.extensions.webcashOutput so callers can
   * persist it. Override to use your own wallet/key derivation.
   */
  mintOutputSecret?: (amountDecimal: string) => string;
  /** TTL for the issuer-health cache, in milliseconds. Default 5000. */
  healthCacheTtlMs?: number;
  /**
   * Legalese object sent with every /replace request. Defaults to the
   * canonical webcash.org form `{ terms: true }`. Override only if you are
   * settling against an issuer fork with different disclosures.
   */
  legalese?: Record<string, unknown>;
  /** Per-request timeout for issuer calls, in milliseconds. Default 30000. */
  issuerTimeoutMs?: number;
  /**
   * Allow non-HTTPS issuer URLs (HTTP, or other schemes). Defaults to
   * false: any allowlisted URL that is not `https://` and not a loopback
   * address is rejected at construction time. Only set this true for
   * local test rigs — webcash secrets transmitted over plaintext can be
   * stolen by any on-path observer.
   */
  allowHttpIssuer?: boolean;
  /**
   * SPKI pins (base64(SHA-256(SPKI DER))) for the issuer TLS endpoint(s).
   * When set, every issuer call performs the standard CA/hostname check AND
   * additionally requires the server's public key hash to match one of the
   * pins. Mismatches surface as a network error with `PinMismatchError` in
   * the cause chain and are reported to the caller as `issuer_unreachable`
   * (the secret was never transmitted to a mis-issued endpoint).
   *
   * Provide at least two pins (current + backup) so key rotation is not an
   * outage. See `src/pinning.ts` for how to compute pin values.
   *
   * Pinning is additive: it strengthens trust, never weakens it. Cannot be
   * combined with a caller-supplied `fetchImpl` — pass one or the other.
   */
  pinnedSpkiHashes?: readonly string[];
};

type Validated = {
  ok: true;
  parsed: ParsedSecret;
  issuerUrl: string;
};

type ValidationFailure = { ok: false; reason: string };

export class Facilitator {
  private readonly allowlist: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly mintOutputSecret: (amountDecimal: string) => string;
  private readonly healthCacheTtlMs: number;
  private readonly legalese: Record<string, unknown>;
  private readonly issuerTimeoutMs: number;
  private readonly healthCache = new Map<string, { ok: boolean; expires: number }>();

  constructor(opts: FacilitatorOptions = {}) {
    const defaults = Object.values(KNOWN_NETWORKS);
    const candidates = [...defaults, ...(opts.issuerAllowlist ?? [])];
    const allowHttp = opts.allowHttpIssuer ?? false;
    // Fail fast on construction — operator typos in the allowlist should
    // not silently degrade to plaintext secret transmission in production.
    for (const url of candidates) {
      if (!isAcceptableIssuerScheme(url, allowHttp)) {
        throw new Error(
          `[x402-webcash] issuer URL "${url}" is not HTTPS and not loopback. ` +
            `Refusing to construct facilitator — webcash secrets would transit in plaintext. ` +
            `Pass allowHttpIssuer:true to override (test rigs only).`,
        );
      }
    }
    this.allowlist = new Set(candidates);
    if (opts.pinnedSpkiHashes?.length && opts.fetchImpl) {
      throw new Error(
        `[x402-webcash] Facilitator: pinnedSpkiHashes and fetchImpl are ` +
          `mutually exclusive — pinning operates at the TLS dispatcher layer, ` +
          `so a caller-supplied fetchImpl would either bypass it (silently ` +
          `unsafe) or double-wrap it. Pick one.`,
      );
    }
    this.fetchImpl = opts.pinnedSpkiHashes?.length
      ? createPinnedFetch({ pinnedSpkiHashes: opts.pinnedSpkiHashes })
      : (opts.fetchImpl ?? fetch);
    this.mintOutputSecret = opts.mintOutputSecret ?? newOutputSecret;
    this.healthCacheTtlMs = opts.healthCacheTtlMs ?? 5000;
    this.legalese = opts.legalese ?? { ...DEFAULT_LEGALESE };
    this.issuerTimeoutMs = opts.issuerTimeoutMs ?? DEFAULT_ISSUER_TIMEOUT_MS;
  }

  supported(): SupportedResponse {
    return {
      kinds: Object.keys(KNOWN_NETWORKS).map((network) => ({
        x402Version: 2 as const,
        scheme: "webcash",
        network,
      })),
      extensions: [],
      signers: {},
    };
  }

  async verify(req: FacilitatorRequest): Promise<VerifyResponse> {
    const v = this.validate(req);
    if (!v.ok) return { isValid: false, invalidReason: v.reason };

    const healthy = await this.checkIssuerHealth(v.issuerUrl);
    if (!healthy) return { isValid: false, invalidReason: "issuer_unreachable" };

    return { isValid: true };
  }

  async settle(req: FacilitatorRequest): Promise<SettlementResponse> {
    const network = req.paymentRequirements.network;
    const v = this.validate(req);
    if (!v.ok) {
      return {
        success: false,
        errorReason: v.reason,
        transaction: "",
        network,
      };
    }

    // Resolve the output secret. Two paths:
    //
    //   (a) Recipient-binding ON  — payload.accepted.extra.recipientPublicHash
    //       is set. The buyer has supplied `payload.outputSecret`; we MUST
    //       use it (we cannot mint our own) and we MUST verify it hashes to
    //       the committed value. This is the only way the resource server
    //       can be sure we did not substitute a secret we control.
    //
    //   (b) Recipient-binding OFF — we mint as before.
    let output: string;
    const bindingResult = resolveBoundOutput(req);
    if (bindingResult.kind === "invalid") {
      return {
        success: false,
        errorReason: bindingResult.reason,
        transaction: "",
        network,
      };
    }
    if (bindingResult.kind === "bound") {
      // Buyer-supplied; verify amount matches the input so we don't settle
      // a smaller-amount secret than the buyer is being charged for.
      const parsedOutput = parseSecret(bindingResult.outputSecret);
      if (!parsedOutput) {
        return {
          success: false,
          errorReason: "invalid_payload: outputSecret does not parse as a webcash secret",
          transaction: "",
          network,
        };
      }
      if (parsedOutput.wats !== v.parsed.wats) {
        return {
          success: false,
          errorReason: "invalid_payload: outputSecret amount does not match input amount",
          transaction: "",
          network,
        };
      }
      output = bindingResult.outputSecret;
    } else {
      // Mint the output secret BEFORE calling /replace so a throw here cannot
      // leave the input spent without a recoverable output. The caller-supplied
      // mintOutputSecret may throw (wallet I/O, exhaustion, etc.); surface that
      // as unexpected_settle_error rather than letting it crash the handler.
      try {
        output = this.mintOutputSecret(watsToDecimal(v.parsed.wats));
      } catch (e) {
        return {
          success: false,
          errorReason: `unexpected_settle_error: mint_output_failed: ${(e as Error).message}`,
          transaction: "",
          network,
        };
      }
    }

    // Skip the explicit health check — the /replace call below is itself the
    // round-trip that proves issuer reachability and yields the canonical
    // success/failure for this settlement.
    const result = await replaceSecret(
      v.issuerUrl,
      v.parsed.raw,
      output,
      this.fetchImpl,
      this.legalese,
      this.issuerTimeoutMs,
    );
    if (!result.ok) {
      return {
        success: false,
        errorReason: mapIssuerReason(result.reason),
        transaction: "",
        network,
      };
    }

    // Surface the new bearer secret so the caller can persist it. Without
    // this, a successful settlement would lose the funds it just received.
    return {
      success: true,
      transaction: secretFingerprint(v.parsed.raw),
      network,
      amount: req.paymentRequirements.amount,
      extensions: {
        webcashOutput: {
          secret: output,
          amountDecimal: watsToDecimal(v.parsed.wats),
          amountWats: v.parsed.wats.toString(),
        },
      },
    };
  }

  /** Shared validation for verify/settle (everything except the health check). */
  private validate(req: FacilitatorRequest): Validated | ValidationFailure {
    const reqs = req.paymentRequirements;

    if (reqs.scheme !== "webcash") return { ok: false, reason: "unsupported_scheme" };
    if (reqs.asset !== "webcash") return { ok: false, reason: "invalid_payment_requirements" };
    if (!reqs.network.startsWith("webcash:")) return { ok: false, reason: "invalid_network" };

    // The client-echoed `accepted` field MUST agree with the server's
    // requirements on every binding field.
    const accepted = req.paymentPayload.accepted;
    if (
      !accepted ||
      accepted.scheme !== reqs.scheme ||
      accepted.network !== reqs.network ||
      accepted.payTo !== reqs.payTo ||
      accepted.amount !== reqs.amount ||
      accepted.asset !== reqs.asset
    ) {
      return { ok: false, reason: "invalid_payload" };
    }
    // Recipient-binding echo: if the server published recipientPublicKey or
    // recipientNonce in its requirements, the buyer MUST echo them unchanged.
    // Buyers MAY add fields (e.g., recipientPublicHash) but MUST NOT swap the
    // server's key or nonce — that would let them point the derivation at a
    // pubkey they control. The resource server's post-settlement check
    // catches this anyway, but failing here gives a cleaner error.
    const reqsExtra = (reqs.extra ?? {}) as Record<string, unknown>;
    const acceptedExtra = (accepted.extra ?? {}) as Record<string, unknown>;
    for (const field of ["recipientPublicKey", "recipientNonce"] as const) {
      if (reqsExtra[field] !== undefined && acceptedExtra[field] !== reqsExtra[field]) {
        return {
          ok: false,
          reason: `invalid_payload: accepted.extra.${field} does not echo paymentRequirements.extra.${field}`,
        };
      }
    }

    const payload = req.paymentPayload.payload as WebcashPayload | undefined;
    if (!payload || typeof payload.secret !== "string") {
      return { ok: false, reason: "invalid_payload" };
    }

    const parsed = parseSecret(payload.secret);
    if (!parsed) return { ok: false, reason: "invalid_webcash_secret_format" };

    let requiredWats: bigint;
    try {
      requiredWats = BigInt(reqs.amount);
    } catch {
      return { ok: false, reason: "invalid_payment_requirements" };
    }
    if (requiredWats <= 0n) return { ok: false, reason: "invalid_payment_requirements" };
    if (parsed.wats !== requiredWats) {
      return { ok: false, reason: "invalid_webcash_amount_mismatch" };
    }

    const issuerUrl = this.resolveIssuerUrl(reqs);
    if (!issuerUrl) return { ok: false, reason: "invalid_network" };

    return { ok: true, parsed, issuerUrl };
  }

  private resolveIssuerUrl(reqs: PaymentRequirements): string | null {
    const override = reqs.extra?.["issuerUrl"];
    const candidate = typeof override === "string" ? override : KNOWN_NETWORKS[reqs.network];
    if (!candidate) return null;
    if (!this.allowlist.has(candidate)) return null;
    // payTo MUST equal the resolved issuer URL (canonical or overridden).
    if (reqs.payTo !== candidate) return null;
    return candidate;
  }

  private async checkIssuerHealth(url: string): Promise<boolean> {
    const cached = this.healthCache.get(url);
    const now = Date.now();
    if (cached && cached.expires > now) return cached.ok;
    const result = await issuerHealth(url, this.fetchImpl, this.issuerTimeoutMs);
    this.healthCache.set(url, { ok: result.ok, expires: now + this.healthCacheTtlMs });
    return result.ok;
  }
}

type BoundOutputResolution =
  | { kind: "none" }
  | { kind: "bound"; outputSecret: string }
  | { kind: "invalid"; reason: string };

/**
 * If the buyer's echoed `accepted.extra.recipientPublicHash` is set, the
 * facilitator MUST use the buyer-supplied output secret (not mint its own)
 * and MUST verify it hashes to the committed value. See specs/scheme_webcash.md
 * "Recipient binding" and src/recipient.ts for the full protocol.
 */
function resolveBoundOutput(req: FacilitatorRequest): BoundOutputResolution {
  const acceptedExtra = (req.paymentPayload.accepted.extra ?? {}) as Record<string, unknown>;
  const claimedHash = acceptedExtra["recipientPublicHash"];
  if (claimedHash === undefined) return { kind: "none" };
  if (typeof claimedHash !== "string" || claimedHash.length === 0) {
    return {
      kind: "invalid",
      reason: "invalid_payload: recipientPublicHash must be a non-empty string",
    };
  }
  const payload = req.paymentPayload.payload as { outputSecret?: unknown };
  const outputSecret = payload.outputSecret;
  if (typeof outputSecret !== "string" || outputSecret.length === 0) {
    return {
      kind: "invalid",
      reason: "invalid_payload: recipientPublicHash set but payload.outputSecret is missing",
    };
  }
  const actualHash = recipientPublicHash(outputSecret);
  // Constant-time string compare via byte XOR — both values are public
  // (the hash is in the request), so this is belt-and-suspenders, but
  // costs nothing.
  if (actualHash.length !== claimedHash.length) {
    return { kind: "invalid", reason: "invalid_payload: recipientPublicHash mismatch" };
  }
  let diff = 0;
  for (let i = 0; i < actualHash.length; i++) {
    diff |= actualHash.charCodeAt(i) ^ claimedHash.charCodeAt(i);
  }
  if (diff !== 0) {
    return { kind: "invalid", reason: "invalid_payload: recipientPublicHash mismatch" };
  }
  return { kind: "bound", outputSecret };
}

function mapIssuerReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("timeout")) return "issuer_unreachable";
  if (r.includes("network_error")) return "issuer_unreachable";
  if (r.includes("insufficient") || r.includes("balance")) return "insufficient_funds";
  if (r.includes("invalid_payload") || r.includes("malformed")) return "invalid_payload";
  if (r.includes("legalese")) return "invalid_payment_requirements";
  return "issuer_rejected";
}

/**
 * Returns true if `url` is `https://` or points at a loopback address
 * (`http://localhost`, `http://127.0.0.1`, `http://[::1]`). Loopback HTTP
 * is allowed unconditionally because it never leaves the host; remote
 * HTTP would put secrets on the wire in plaintext.
 *
 * When `allowHttp` is true, any well-formed URL passes — operator opt-in
 * for test rigs against a sandbox issuer.
 */
export function isAcceptableIssuerScheme(url: string, allowHttp: boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  if (allowHttp) return true;
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
