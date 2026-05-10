// Webcash issuer client + secret parsing utilities.
// Talks to the canonical issuer at https://webcash.org by default; alternative
// issuers must be added to the facilitator allowlist before use.

import { createHash, randomBytes } from "node:crypto";

// Strict: leading "e", up to 8 fractional digits (wat precision), no whitespace,
// lowercase hex only. Whole and fractional parts both required to be present.
const SECRET_RE = /^e(\d+)(?:\.(\d{1,8}))?:secret:([0-9a-f]+)$/;

export const KNOWN_NETWORKS: Record<string, string> = {
  "webcash:mainnet": "https://webcash.org",
  "webcash:testnet": "https://webcash.org", // no public testnet exists; placeholder
};

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
  const wats = BigInt(whole) * 100_000_000n + BigInt(padded || "0");
  if (wats === 0n) return null;
  const decimal = frac ? `${whole}.${frac}` : whole;
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

export async function issuerHealth(issuerUrl: string, fetchImpl: typeof fetch = fetch): Promise<IssuerHealth> {
  try {
    const res = await fetchImpl(`${issuerUrl.replace(/\/$/, "")}/api/v1/health_check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { ok: res.ok, status: res.status, body: await safeJson(res) };
  } catch {
    return { ok: false };
  }
}

export type ReplaceResult =
  | { ok: true; outputs: string[] }
  | { ok: false; status?: number; reason: string };

export async function replaceSecret(
  issuerUrl: string,
  input: string,
  output: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReplaceResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${issuerUrl.replace(/\/$/, "")}/api/v1/replace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        webcashes: [input],
        new_webcashes: [output],
        legalese: { terms: true },
      }),
    });
  } catch (e) {
    return { ok: false, reason: `network_error: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const body = await safeJson(res);
    const reason = (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string")
      ? (body as { error: string }).error
      : `issuer_status_${res.status}`;
    return { ok: false, status: res.status, reason };
  }
  return { ok: true, outputs: [output] };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
