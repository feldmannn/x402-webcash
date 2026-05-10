// Webcash issuer client + secret parsing utilities.
// Talks to the canonical issuer at https://webcash.org by default; alternative
// issuers must be added to the facilitator allowlist before use.
//
// Endpoint paths and the `legalese` shape are taken from the canonical
// webcash client (kanzure/webcash, webcash/webcashbase.py + walletclient.py):
//   - /api/v1/health_check
//   - /api/v1/replace  with body { webcashes, new_webcashes, legalese }
//   - LEGALESE = { "terms": "I acknowledge and agree to the Terms of Service ..." }
//     and replace requests send the acknowledged form { "terms": true }.

import { createHash, randomBytes } from "node:crypto";

// Strict: leading "e", up to 8 fractional digits (wat precision), no whitespace,
// lowercase hex only.
const SECRET_RE = /^e(\d+)(?:\.(\d{1,8}))?:secret:([0-9a-f]+)$/;

export const KNOWN_NETWORKS: Record<string, string> = {
  "webcash:mainnet": "https://webcash.org",
  "webcash:testnet": "https://webcash.org", // no public testnet exists; placeholder
};

/**
 * Default legalese object sent with every /replace call. Matches the canonical
 * webcash client's acknowledged form. Forks of the issuer with different
 * disclosures may need a different shape; pass `legalese` to the facilitator.
 */
export const DEFAULT_LEGALESE: Readonly<Record<string, unknown>> = Object.freeze({ terms: true });

export const DEFAULT_ISSUER_TIMEOUT_MS = 30_000;

export type ParsedSecret = {
  decimal: string;
  wats: bigint;
  hex: string;
  raw: string;
};

export function parseSecret(s: string): ParsedSecret | null {
  if (typeof s !== "string") return null;
  const m = SECRET_RE.exec(s);
  if (!m) return null;
  const whole = m[1];
  const frac = m[2] ?? "";
  const hex = m[3];
  const padded = (frac + "00000000").slice(0, 8);
  const wats = BigInt(whole) * 100_000_000n + BigInt(padded);
  if (wats === 0n) return null;
  // Normalize to canonical form so callers don't see two strings for the same
  // amount (e.g. "1.30" vs "1.3"). The original input is preserved in `raw`.
  const decimal = watsToDecimal(wats);
  return { decimal, wats, hex, raw: s };
}

export function watsToDecimal(wats: bigint): string {
  const whole = wats / 100_000_000n;
  const frac = wats % 100_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function newOutputSecret(amountDecimal: string): string {
  const hex = randomBytes(32).toString("hex");
  return `e${amountDecimal}:secret:${hex}`;
}

export type IssuerHealth = { ok: boolean; status?: number; body?: unknown };

export async function issuerHealth(
  issuerUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_ISSUER_TIMEOUT_MS,
): Promise<IssuerHealth> {
  try {
    const res = await fetchImpl(`${issuerUrl.replace(/\/$/, "")}/api/v1/health_check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, body: await safeJson(res) };
  } catch {
    return { ok: false };
  }
}

export type ReplaceResult =
  | { ok: true; outputs: string[] }
  | { ok: false; status?: number; reason: string };

/**
 * Atomic replacement at the issuer.
 *
 * `input` and `output` may each be either a single secret or an array.
 * The issuer enforces that the total wat amount of inputs equals the total
 * wat amount of outputs; mismatches are rejected.
 *
 * Common shapes:
 * - 1 input -> 1 output: a "refresh" (same amount, new bearer hex).
 * - 1 input -> 2 outputs: a "split" — pay one party, keep change.
 * - N inputs -> 1 output: a "merge" — consolidate denominations.
 */
export async function replaceSecret(
  issuerUrl: string,
  input: string | string[],
  output: string | string[],
  fetchImpl: typeof fetch = fetch,
  legalese: Record<string, unknown> = DEFAULT_LEGALESE,
  timeoutMs: number = DEFAULT_ISSUER_TIMEOUT_MS,
): Promise<ReplaceResult> {
  const inputs = Array.isArray(input) ? input : [input];
  const outputs = Array.isArray(output) ? output : [output];
  let res: Response;
  try {
    res = await fetchImpl(`${issuerUrl.replace(/\/$/, "")}/api/v1/replace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webcashes: inputs,
        new_webcashes: outputs,
        legalese,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const reason = (e as Error).name === "TimeoutError" || msg.toLowerCase().includes("timeout")
      ? `timeout: ${msg}`
      : `network_error: ${msg}`;
    return { ok: false, reason };
  }
  const body = await safeJson(res);
  if (!res.ok) {
    const reason = extractErrorString(body) ?? `issuer_status_${res.status}`;
    return { ok: false, status: res.status, reason };
  }
  // Defensive: even on 2xx, treat a body with a top-level `error` field as
  // failure. Some servers respond 200 with an error envelope; we MUST NOT
  // consider the secret unspent if the issuer is signaling otherwise.
  const errInBody = extractErrorString(body);
  if (errInBody) {
    return { ok: false, status: res.status, reason: errInBody };
  }
  return { ok: true, outputs };
}

function extractErrorString(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string" && b.error.length > 0) return b.error;
  if (Array.isArray(b.errors) && b.errors.length > 0 && typeof b.errors[0] === "string") {
    return b.errors[0] as string;
  }
  if (b.success === false) {
    return typeof b.message === "string" ? b.message : "issuer_signalled_failure";
  }
  return null;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
