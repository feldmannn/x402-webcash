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
  KNOWN_NETWORKS,
  ParsedSecret,
  issuerHealth,
  newOutputSecret,
  parseSecret,
  replaceSecret,
  secretFingerprint,
  watsToDecimal,
} from "./webcash.js";

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
};

type Validated = {
  ok: true;
  parsed: ParsedSecret;
  issuerUrl: string;
  payload: WebcashPayload;
};

type ValidationFailure = { ok: false; reason: string };

export class Facilitator {
  private readonly allowlist: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly mintOutputSecret: (amountDecimal: string) => string;
  private readonly healthCacheTtlMs: number;
  private readonly healthCache = new Map<string, { ok: boolean; expires: number }>();

  constructor(opts: FacilitatorOptions = {}) {
    const defaults = Object.values(KNOWN_NETWORKS);
    this.allowlist = new Set([...defaults, ...(opts.issuerAllowlist ?? [])]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.mintOutputSecret = opts.mintOutputSecret ?? newOutputSecret;
    this.healthCacheTtlMs = opts.healthCacheTtlMs ?? 5000;
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

    // Skip the explicit health check — the /replace call below is itself the
    // round-trip that proves issuer reachability and yields the canonical
    // success/failure for this settlement.
    const output = this.mintOutputSecret(watsToDecimal(v.parsed.wats));
    const result = await replaceSecret(v.issuerUrl, v.parsed.raw, output, this.fetchImpl);
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

    // The client-echoed `accepted` field MUST agree with the server's
    // requirements on at least scheme and network — otherwise the payload
    // wasn't built against this resource.
    const accepted = req.paymentPayload.accepted;
    if (!accepted || accepted.scheme !== reqs.scheme || accepted.network !== reqs.network) {
      return { ok: false, reason: "invalid_payload" };
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

    return { ok: true, parsed, issuerUrl, payload };
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
    const result = await issuerHealth(url, this.fetchImpl);
    this.healthCache.set(url, { ok: result.ok, expires: now + this.healthCacheTtlMs });
    return result.ok;
  }
}

function mapIssuerReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("network_error")) return "issuer_unreachable";
  if (r.includes("insufficient")) return "insufficient_funds";
  return "issuer_rejected";
}
