// Split-on-demand: derive an exact-amount secret from a larger one by
// asking the issuer to atomically replace it with [required, change].
//
// Why this exists: x402 `webcash` requires the spent amount to exactly
// equal `paymentRequirements.amount`. Without auto-split, agents must
// pre-stage a wallet of exactly-right denominations — a real UX gotcha
// because every endpoint can charge a different amount. With auto-split
// the client just holds value and slices off the right amount on demand.
//
// Failure-mode discipline (mirrors src/middleware.ts on the server side):
//   - input was rejected by issuer (4xx) -> input is unspent, return it to
//     wallet, surface error to caller.
//   - network error / timeout (issuer unreachable) -> input MAY or MAY NOT
//     be spent. Do NOT return it to the wallet. Both newly-minted output
//     secrets and the input are written to stderr with
//     [x402-webcash][CRITICAL] so an operator can recover them.
//   - success -> change is persisted to wallet BEFORE returning the
//     required secret. If change persistence fails the change secret is
//     CRITICAL-logged so it can be manually recovered.

import { DEFAULT_LEGALESE, DEFAULT_ISSUER_TIMEOUT_MS, newOutputSecret, parseSecret, replaceSecret, watsToDecimal } from "../webcash.js";
import type { Wallet } from "./wallet.js";

export type SplitOptions = {
  issuerUrl: string;
  fetchImpl?: typeof fetch;
  legalese?: Record<string, unknown>;
  timeoutMs?: number;
  /** Override the change-secret minter (used by tests to make outputs deterministic). */
  mintOutputSecret?: (amountDecimal: string) => string;
};

export class NoSplittableSecretError extends Error {
  readonly requiredWats: string;
  constructor(requiredWats: string) {
    super(`wallet has no secret larger than ${requiredWats} wats to split from`);
    this.name = "NoSplittableSecretError";
    this.requiredWats = requiredWats;
  }
}

export class IssuerRejectedSplitError extends Error {
  readonly reason: string;
  readonly status?: number;
  constructor(reason: string, status?: number) {
    super(`issuer rejected split: ${reason}`);
    this.name = "IssuerRejectedSplitError";
    this.reason = reason;
    this.status = status;
  }
}

export class AmbiguousSplitError extends Error {
  readonly inputSecret: string;
  readonly requiredOutput: string;
  readonly changeOutput: string;
  readonly reason: string;
  constructor(inputSecret: string, requiredOutput: string, changeOutput: string, reason: string) {
    super(
      `split outcome is ambiguous (${reason}); input may or may not be spent. ` +
        `Check stderr for [x402-webcash][CRITICAL] breadcrumbs to recover secrets.`,
    );
    this.name = "AmbiguousSplitError";
    this.inputSecret = inputSecret;
    this.requiredOutput = requiredOutput;
    this.changeOutput = changeOutput;
    this.reason = reason;
  }
}

/**
 * Find the smallest secret in the wallet whose amount strictly exceeds
 * `requiredWats`, split it at the issuer into [required, change], persist
 * the change back to the wallet, and return the required-amount secret.
 *
 * Returns `null` if no larger secret exists in the wallet (caller should
 * treat this the same as a dry wallet for the required amount).
 *
 * Throws `IssuerRejectedSplitError` on a clean issuer rejection (input
 * still unspent and returned to wallet) and `AmbiguousSplitError` on a
 * network failure (input is in limbo, NOT returned to wallet, breadcrumb
 * logged to stderr).
 */
export async function splitToMatch(
  wallet: Wallet,
  requiredWats: string,
  opts: SplitOptions,
): Promise<string | null> {
  const target = BigInt(requiredWats);
  if (target <= 0n) {
    throw new Error("splitToMatch requires a positive wat amount");
  }

  const candidates = await wallet.list();
  let bestSecret: string | null = null;
  let bestWats: bigint | null = null;
  for (const s of candidates) {
    const parsed = parseSecret(s);
    if (!parsed) continue;
    if (parsed.wats > target && (bestWats === null || parsed.wats < bestWats)) {
      bestSecret = s;
      bestWats = parsed.wats;
    }
  }
  if (bestSecret === null || bestWats === null) return null;

  const changeWats = bestWats - target;
  const mint = opts.mintOutputSecret ?? newOutputSecret;
  const requiredOutput = mint(watsToDecimal(target));
  const changeOutput = mint(watsToDecimal(changeWats));

  // Breadcrumb BEFORE touching the wallet or the issuer. If any subsequent
  // step crashes the operator can still recover from this single log line.
  criticalLog(
    `split_pending input=${bestSecret} required_output=${requiredOutput} ` +
      `change_output=${changeOutput} issuer=${opts.issuerUrl}`,
  );

  // Take the input out of the wallet so a concurrent split can't pick it
  // up. If the take loses a race (returns false), the input has already
  // been claimed; surface a NoSplittable so the caller can retry.
  const took = await wallet.take(bestSecret);
  if (!took) {
    throw new NoSplittableSecretError(requiredWats);
  }

  const result = await replaceSecret(
    opts.issuerUrl,
    bestSecret,
    [requiredOutput, changeOutput],
    opts.fetchImpl ?? fetch,
    opts.legalese ?? DEFAULT_LEGALESE,
    opts.timeoutMs ?? DEFAULT_ISSUER_TIMEOUT_MS,
  );

  if (result.ok) {
    try {
      await wallet.put(changeOutput);
    } catch (err) {
      // The split DID happen at the issuer. The change secret is valid but
      // we failed to durably record it. Log it to stderr — that's the
      // last-resort recovery channel.
      criticalLog(
        `change_persistence_failed change=${changeOutput} amountWats=${changeWats.toString()} ` +
          `error=${(err as Error)?.message ?? String(err)}`,
      );
      throw err;
    }
    return requiredOutput;
  }

  // result.ok === false. Two cases:
  //   - status present -> issuer was reachable and returned an error. Input is unspent.
  //   - status absent -> network error / timeout. Input is in limbo.
  if (typeof result.status === "number") {
    // Clean rejection — return the input to the wallet and surface.
    try {
      await wallet.put(bestSecret);
    } catch (err) {
      criticalLog(
        `input_restore_failed_after_rejection input=${bestSecret} reason=${result.reason} ` +
          `error=${(err as Error)?.message ?? String(err)}`,
      );
    }
    throw new IssuerRejectedSplitError(result.reason, result.status);
  }

  // Ambiguous — we don't know if the issuer applied the replacement.
  criticalLog(
    `split_ambiguous input=${bestSecret} required_output=${requiredOutput} ` +
      `change_output=${changeOutput} reason=${result.reason} issuer=${opts.issuerUrl} — ` +
      `inspect the issuer to determine if input has been spent. If it has, both ` +
      `output secrets are valid bearer tokens; recover them from this log line.`,
  );
  throw new AmbiguousSplitError(bestSecret, requiredOutput, changeOutput, result.reason);
}

function criticalLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[x402-webcash][CRITICAL] ${msg}`);
}
