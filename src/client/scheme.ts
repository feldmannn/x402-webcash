// Client-side scheme handler: build the X-PAYMENT header that satisfies a
// `webcash` 402 challenge.
//
// Transport-agnostic — call this from any HTTP client (fetch, axios, undici,
// MCP transport, etc.). See `./fetch.ts` for a ready-made fetch wrapper.

import { Buffer } from "node:buffer";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, WebcashPayload } from "../types.js";
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
 * Build an X-PAYMENT header for a 402 challenge that advertises `webcash`.
 *
 * Returns `null` if the 402 body does not offer the webcash scheme (the
 * caller may want to try another scheme handler). Throws
 * `NoMatchingSecretError` if webcash is offered but the wallet has no
 * secret of the required amount.
 *
 * On success the matching secret has been REMOVED from the wallet. If the
 * subsequent retry does not return a 2xx response, the caller MUST call
 * `wallet.put(result.secret)` to return it — otherwise it is lost to the
 * wallet even though it remains spendable at the issuer.
 */
export async function buildWebcashHeader(
  body: PaymentRequired,
  wallet: Wallet,
): Promise<BuiltHeader | null> {
  if (!body || body.x402Version !== 2 || !Array.isArray(body.accepts)) {
    return null;
  }
  const requirements = body.accepts.find((r) => r?.scheme === WEBCASH_SCHEME);
  if (!requirements) return null;

  const secret = await wallet.takeExact(requirements.amount);
  if (!secret) throw new NoMatchingSecretError(requirements.amount);

  const payload: PaymentPayload<WebcashPayload> = {
    x402Version: 2,
    accepted: requirements,
    payload: { secret },
  };
  const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return { header, requirements, secret };
}
