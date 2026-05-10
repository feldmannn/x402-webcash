// fetch-shaped wrapper that auto-handles webcash 402 challenges.
//
// Usage:
//
//   const wallet = new FileWallet("./wallet.json");
//   const pay = wrapFetchWithWebcash(fetch, { wallet });
//   const res = await pay("http://api.example.com/premium");
//
// On a 402 advertising `webcash`, the wrapper takes a matching secret from
// the wallet, attaches `X-PAYMENT`, and retries once. If the retry returns
// 2xx the call succeeds. If the retry returns 402 the secret is returned
// to the wallet (settlement did not run). Any other non-2xx is treated as
// ambiguous — the secret may or may not have been spent — and the secret
// is written to stderr with the `[x402-webcash][CRITICAL]` marker so an
// operator can recover it.

import type { PaymentRequired } from "../types.js";
import { buildWebcashHeader, NoMatchingSecretError } from "./scheme.js";
import type { Wallet } from "./wallet.js";

export type WrapFetchOptions = {
  wallet: Wallet;
  /**
   * Hook fired when a retry returns an ambiguous status (neither 2xx nor
   * 402). The secret may already be spent at the issuer; the hook is the
   * caller's chance to write it to a quarantine store for manual recovery.
   * If omitted, the secret is only logged to stderr.
   */
  onAmbiguous?: (info: { secret: string; status: number; body: unknown }) => void | Promise<void>;
};

type FetchLike = typeof fetch;

const RETRY_FLAG = Symbol.for("x402-webcash.retried");

type RetriedInit = RequestInit & { [k: symbol]: boolean };

/**
 * Wrap a fetch-shaped function so that 402 responses advertising webcash
 * are automatically settled from `opts.wallet` and the request is retried
 * exactly once. Schemes other than webcash are passed through unchanged
 * (the caller can chain another wrapper for those).
 */
export function wrapFetchWithWebcash(fetchImpl: FetchLike, opts: WrapFetchOptions): FetchLike {
  const { wallet, onAmbiguous } = opts;

  const wrapped: FetchLike = async (input, init) => {
    const initObj = (init ?? {}) as RetriedInit;
    if (initObj[RETRY_FLAG]) {
      // We're already inside a retry; do not recurse.
      return fetchImpl(input, init);
    }

    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;

    let body: PaymentRequired;
    try {
      // Clone so the caller can still read the body if we end up handing
      // back the original response (e.g. wrong scheme).
      body = (await first.clone().json()) as PaymentRequired;
    } catch {
      return first;
    }

    let built: Awaited<ReturnType<typeof buildWebcashHeader>>;
    try {
      built = await buildWebcashHeader(body, wallet);
    } catch (err) {
      if (err instanceof NoMatchingSecretError) {
        // Surface as a thrown error rather than the original 402 so callers
        // can distinguish "server rejected payment" from "wallet has no
        // funds to attempt payment in the first place."
        throw err;
      }
      throw err;
    }
    if (!built) {
      // 402 did not offer webcash; let the caller's other handlers run.
      return first;
    }

    const retryInit: RetriedInit = {
      ...initObj,
      [RETRY_FLAG]: true,
      method: initObj.method ?? "GET",
      headers: mergeHeaders(initObj.headers, { "X-PAYMENT": built.header }),
    };

    const retry = await fetchImpl(input, retryInit);

    if (retry.ok) return retry;

    if (retry.status === 402) {
      // The server did not settle our payment (e.g. facilitator unreachable,
      // settlement rejected). The secret was NOT spent — put it back.
      try {
        await wallet.put(built.secret);
      } catch (err) {
        criticalLog(
          `wallet_put_failed_after_402 secret=${built.secret} ` +
            `error=${(err as Error)?.message ?? String(err)}`,
        );
      }
      return retry;
    }

    // Ambiguous: any non-2xx, non-402 status. The secret may or may not be
    // spent. Do NOT put it back into the wallet (would risk double-spend
    // attempts). Surface to a quarantine hook and log unconditionally.
    let bodyForHook: unknown;
    try {
      bodyForHook = await retry.clone().json();
    } catch {
      bodyForHook = undefined;
    }
    criticalLog(
      `ambiguous_response status=${retry.status} secret=${built.secret} ` +
        `transaction_fingerprint=unknown — investigate at the issuer to determine if the secret is spent.`,
    );
    if (onAmbiguous) {
      try {
        await onAmbiguous({ secret: built.secret, status: retry.status, body: bodyForHook });
      } catch (err) {
        criticalLog(
          `onAmbiguous_callback_failed secret=${built.secret} ` +
            `error=${(err as Error)?.message ?? String(err)}`,
        );
      }
    }
    return retry;
  };

  return wrapped;
}

function mergeHeaders(existing: RequestInit["headers"], extra: Record<string, string>): Headers {
  const h = new Headers(existing ?? {});
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function criticalLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[x402-webcash][CRITICAL] ${msg}`);
}
