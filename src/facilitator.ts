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
  // Caller-supplied output-secret factory; defaults to a fresh random secret.
  // In production the caller should persist these to a wallet before settlement.
  mintOutputSecret?: (amountDecimal: string) => string;
};

export class Facilitator {
  private readonly allowlist: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly mintOutputSecret: (amountDecimal: string) => string;

  constructor(opts: FacilitatorOptions = {}) {
    const defaults = Object.values(KNOWN_NETWORKS);
    this.allowlist = new Set([...defaults, ...(opts.issuerAllowlist ?? [])]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.mintOutputSecret = opts.mintOutputSecret ?? newOutputSecret;
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
    const reqs = req.paymentRequirements;
    const reject = this.preflight(reqs);
    if (reject) return reject;

    const payload = req.paymentPayload.payload as WebcashPayload | undefined;
    if (!payload || typeof payload.secret !== "string") {
      return { isValid: false, invalidReason: "invalid_payload" };
    }

    const parsed = parseSecret(payload.secret);
    if (!parsed) {
      return { isValid: false, invalidReason: "invalid_webcash_secret_format" };
    }

    let requiredWats: bigint;
    try {
      requiredWats = BigInt(reqs.amount);
    } catch {
      return { isValid: false, invalidReason: "invalid_payment_requirements" };
    }
    if (parsed.wats !== requiredWats) {
      return { isValid: false, invalidReason: "invalid_webcash_amount_mismatch" };
    }

    const issuerUrl = this.resolveIssuerUrl(reqs);
    if (!issuerUrl) return { isValid: false, invalidReason: "invalid_network" };

    const health = await issuerHealth(issuerUrl, this.fetchImpl);
    if (!health.ok) {
      return { isValid: false, invalidReason: "issuer_unreachable" };
    }

    return { isValid: true };
  }

  async settle(req: FacilitatorRequest): Promise<SettlementResponse> {
    const reqs = req.paymentRequirements;
    const verify = await this.verify(req);
    if (!verify.isValid) {
      return {
        success: false,
        errorReason: verify.invalidReason ?? "unexpected_verify_error",
        transaction: "",
        network: reqs.network,
      };
    }

    const payload = req.paymentPayload.payload as WebcashPayload;
    const parsed = parseSecret(payload.secret)!; // verify guaranteed parseable
    const issuerUrl = this.resolveIssuerUrl(reqs)!;

    const output = this.mintOutputSecret(watsToDecimal(parsed.wats));
    const result = await replaceSecret(issuerUrl, payload.secret, output, this.fetchImpl);
    if (!result.ok) {
      return {
        success: false,
        errorReason: mapIssuerReason(result.reason),
        transaction: "",
        network: reqs.network,
      };
    }

    return {
      success: true,
      transaction: secretFingerprint(payload.secret),
      network: reqs.network,
      amount: reqs.amount,
    };
  }

  private preflight(reqs: PaymentRequirements): VerifyResponse | null {
    if (reqs.scheme !== "webcash") {
      return { isValid: false, invalidReason: "unsupported_scheme" };
    }
    if (reqs.asset !== "webcash") {
      return { isValid: false, invalidReason: "invalid_payment_requirements" };
    }
    if (!KNOWN_NETWORKS[reqs.network] && !reqs.extra?.["issuerUrl"]) {
      return { isValid: false, invalidReason: "invalid_network" };
    }
    return null;
  }

  private resolveIssuerUrl(reqs: PaymentRequirements): string | null {
    const override = reqs.extra?.["issuerUrl"];
    const candidate = typeof override === "string" ? override : KNOWN_NETWORKS[reqs.network];
    if (!candidate) return null;
    if (!this.allowlist.has(candidate)) return null;
    if (typeof override === "string" && override !== reqs.payTo) return null;
    return candidate;
  }
}

function mapIssuerReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("network_error")) return "issuer_unreachable";
  if (r.includes("insufficient")) return "insufficient_funds";
  return "issuer_rejected";
}
