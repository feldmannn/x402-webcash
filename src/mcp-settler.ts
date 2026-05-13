// Adapter from x402-webcash's Facilitator to the x402-mcp Settler interface.
// Pass the return value as `settler` to x402-mcp's createPaywall — the
// structural match is sufficient; this file imports nothing from x402-mcp.

import type { Facilitator } from "./facilitator.js";
import type { FacilitatorRequest, PaymentPayload, PaymentRequirements, WebcashPayload } from "./types.js";
import type { WebcashOutput } from "./middleware.js";
import { parseSecret } from "./webcash.js";

/**
 * Wrap a Facilitator so it can paywall MCP tools via x402-mcp.
 *
 * Failure → retriable semantics:
 *   - `unexpected_settle_error_*`: facilitator-side problem (e.g. mint
 *     failure); the issuer was never called and the input secret is
 *     untouched, so the SAME input may be safely retried → retriable: true.
 *   - All other failures: either the input was consumed at the issuer,
 *     definitively rejected, or the request was malformed; retrying with
 *     the SAME input cannot succeed → retriable: false. The wallet must
 *     use a different input to proceed.
 *
 * Success → integrity gate:
 *   - A successful Facilitator.settle MUST carry the newly-minted output
 *     in `extensions.webcashOutput`. A success response without it means
 *     the facilitator has lost or stolen the secret. We surface this as
 *     a NON-success result (retriable: false) and log CRITICAL so the
 *     operator can audit the facilitator.
 */
export function webcashSettler(facilitator: Facilitator) {
  return async (
    payload: PaymentPayload<WebcashPayload>,
    requirements: PaymentRequirements,
  ): Promise<
    | { ok: true; transaction: string; payer?: string; output: WebcashOutput }
    | { ok: false; reason: string; retriable: boolean }
  > => {
    const req: FacilitatorRequest = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };
    const settled = await facilitator.settle(req);

    if (!settled.success) {
      const reason = settled.errorReason ?? "settlement_failed";
      return {
        ok: false,
        reason,
        retriable: reason.startsWith("unexpected_settle_error"),
      };
    }

    const output = (settled.extensions as { webcashOutput?: WebcashOutput } | undefined)?.webcashOutput;
    if (!isValidOutputShape(output)) {
      // eslint-disable-next-line no-console
      console.error(
        `[x402-webcash][CRITICAL] missing_or_malformed_output_secret transaction=${settled.transaction} ` +
          `network=${settled.network}. The facilitator returned success but did not surface the new ` +
          `bearer token. Funds may have settled at the issuer without the resource server receiving ` +
          `them — investigate the facilitator immediately.`,
      );
      return {
        ok: false,
        reason: "settlement_integrity_failure: facilitator returned success without webcashOutput",
        retriable: false,
      };
    }

    // Amount-integrity gate: a compromised or buggy facilitator could
    // return a well-shaped output for an amount smaller (or different)
    // than what the buyer paid. Parse the actual secret and compare its
    // embedded wats against the requirements. Trust the secret string
    // (which the seller will spend) over the sidecar amountWats/Decimal
    // metadata (which is informational and can be fabricated).
    const parsed = parseSecret(output.secret);
    if (!parsed) {
      // eslint-disable-next-line no-console
      console.error(
        `[x402-webcash][CRITICAL] unparseable_output_secret transaction=${settled.transaction} ` +
          `network=${settled.network}. The facilitator returned a string that does not parse as a ` +
          `webcash secret. Audit the facilitator.`,
      );
      return {
        ok: false,
        reason: "settlement_integrity_failure: output secret does not parse as webcash",
        retriable: false,
      };
    }

    let requiredWats: bigint;
    try {
      requiredWats = BigInt(requirements.amount);
    } catch {
      return {
        ok: false,
        reason: "settlement_integrity_failure: requirements.amount is not a valid wat integer",
        retriable: false,
      };
    }

    if (parsed.wats !== requiredWats) {
      // eslint-disable-next-line no-console
      console.error(
        `[x402-webcash][CRITICAL] output_amount_mismatch transaction=${settled.transaction} ` +
          `network=${settled.network} required_wats=${requiredWats.toString()} ` +
          `output_wats=${parsed.wats.toString()}. The facilitator returned a secret for a different ` +
          `amount than the buyer was charged. DO NOT PERSIST. Audit the facilitator immediately.`,
      );
      return {
        ok: false,
        reason:
          `settlement_integrity_failure: output amount ${parsed.wats.toString()} wats does not match ` +
          `required ${requiredWats.toString()} wats`,
        retriable: false,
      };
    }

    return {
      ok: true,
      transaction: settled.transaction,
      ...(settled.payer ? { payer: settled.payer } : {}),
      output,
    };
  };
}

function isValidOutputShape(o: unknown): o is WebcashOutput {
  if (!o || typeof o !== "object") return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x.secret === "string" &&
    x.secret.length > 0 &&
    typeof x.amountDecimal === "string" &&
    typeof x.amountWats === "string"
  );
}
