// Client-side scheme handler: build the X-PAYMENT header that satisfies a
// `webcash` 402 challenge.
//
// Transport-agnostic — call this from any HTTP client (fetch, axios, undici,
// MCP transport, etc.). See `./fetch.ts` for a ready-made fetch wrapper.

import { Buffer } from "node:buffer";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, WebcashPayload } from "../types.js";
import { splitToMatch, type SplitOptions } from "./split.js";
import type { Wallet } from "./wallet.js";

export const WEBCASH_SCHEME = "webcash";

export class NoMatchingSecretError extends Error {
  readonly wats: string;
  constructor(wats: string) {
    super(`wallet has no unspent webcash secret of ${wats} wats`);
    this.name = "NoMatchingSecretError";
    this.wats = wats;
  }
}

/**
 * Return value of `buildWebcashHeader`. The `secret` field is exposed so the
 * caller can put it back in the wallet if the subsequent request ultimately
 * did not settle (e.g. resource server returned 402 again, signalling the
 * facilitator did not run).
 */
export type BuiltHeader = {
  header: string;
  requirements: PaymentRequirements;
  secret: string;
};

/**
 * Options accepted by `buildWebcashHeader` beyond the wallet itself.
 *
 * - `autoSplit`: if set, and the wallet has no exact-amount secret, fall
 *   back to splitting a larger one at the issuer. The issuer URL is
 *   derived from the 402 challenge (`extra.issuerUrl` if present, else
 *   `payTo`). Pass overrides via the AutoSplitOptions members.
 */
export type BuildHeaderOptions = {
  autoSplit?: AutoSplitOptions;
};

export type AutoSplitOptions = {
  /** Override the issuer URL inferred from the 402 challenge. */
  issuerUrl?: string;
  fetchImpl?: typeof fetch;
  legalese?: Record<string, unknown>;
  timeoutMs?: number;
  mintOutputSecret?: (amountDecimal: string) => string;
};

/**
 * Build an X-PAYMENT header for a 402 challenge that advertises `webcash`.
 *
 * Returns `null` if the 402 body does not offer the webcash scheme (the
 * caller may want to try another scheme handler).
 *
 * If `opts.autoSplit` is set and the wallet has no exact-amount secret,
 * attempts to split a larger secret via the issuer; see `splitToMatch`
 * for the failure-mode contract (clean rejection vs. ambiguous network
 * failure).
 *
 * Throws `NoMatchingSecretError` if webcash is offered but no secret can
 * be assembled — neither an exact match nor (when auto-split is on) any
 * larger secret to split from.
 *
 * On success the returned `secret` has been REMOVED from the wallet (and,
 * if auto-split fired, the change has been put back). If the subsequent
 * retry does not return 2xx, the caller MUST `wallet.put(result.secret)`
 * to return it.
 */
export async function buildWebcashHeader(
  body: PaymentRequired,
  wallet: Wallet,
  opts: BuildHeaderOptions = {},
): Promise<BuiltHeader | null> {
  if (!body || body.x402Version !== 2 || !Array.isArray(body.accepts)) {
    return null;
  }
  const requirements = body.accepts.find((r) => r?.scheme === WEBCASH_SCHEME);
  if (!requirements) return null;

  let secret = await wallet.takeExact(requirements.amount);
  if (!secret && opts.autoSplit) {
    const issuerUrl = opts.autoSplit.issuerUrl ?? deriveIssuerUrl(requirements);
    const split: SplitOptions = {
      issuerUrl,
      fetchImpl: opts.autoSplit.fetchImpl,
      legalese: opts.autoSplit.legalese,
      timeoutMs: opts.autoSplit.timeoutMs,
      mintOutputSecret: opts.autoSplit.mintOutputSecret,
    };
    secret = await splitToMatch(wallet, requirements.amount, split);
  }
  if (!secret) throw new NoMatchingSecretError(requirements.amount);

  const payload: PaymentPayload<WebcashPayload> = {
    x402Version: 2,
    accepted: requirements,
    payload: { secret },
  };
  const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return { header, requirements, secret };
}

function deriveIssuerUrl(r: PaymentRequirements): string {
  const fromExtra = (r.extra as { issuerUrl?: unknown } | undefined)?.issuerUrl;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  return r.payTo;
}
