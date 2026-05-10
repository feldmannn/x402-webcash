// Example: spend a webcash secret via a wrapped fetch against the example
// resource server (`npm run example`).
//
// Prerequisites:
//   1. `npm run facilitator`  — facilitator on :4021
//   2. `npm run example`      — paywalled resource server on :4020
//   3. A real unspent webcash secret of exactly 0.3 webcash (the amount the
//      example endpoint demands). Seed it into the wallet file:
//
//        echo '{"secrets":["e0.3:secret:<your-hex>"]}' > ./client-wallet.json
//
//      (Webcash secrets must be acquired from the issuer — see webcash.org.
//      Without a real secret the example will throw NoMatchingSecretError.)
//
// Run:
//   npx tsx examples/fetch-client.ts
//
// What happens:
//   GET /premium → 402 with PaymentRequired (advertising scheme: "webcash")
//   wrapper takes the matching secret from the wallet, base64-encodes a
//   PaymentPayload, retries with X-PAYMENT, the facilitator settles via
//   webcash.org/api/v1/replace, the resource server persists the output
//   secret, and the wrapper returns the 200 body to the caller.

import { resolve } from "node:path";
import { FileWallet, NoMatchingSecretError, wrapFetchWithWebcash } from "../src/client/index.js";

const RESOURCE_URL = process.env.RESOURCE_URL ?? "http://localhost:4020/premium";
const WALLET_FILE = resolve(process.env.WALLET_FILE ?? "./client-wallet.json");

async function main(): Promise<void> {
  const wallet = new FileWallet(WALLET_FILE);
  const pay = wrapFetchWithWebcash(fetch, {
    wallet,
    onAmbiguous: ({ secret, status }) => {
      // eslint-disable-next-line no-console
      console.error(
        `[x402-webcash][CLIENT-QUARANTINE] status=${status} secret=${secret} — ` +
          `secret may have been spent at the issuer; do not return to wallet.`,
      );
    },
  });

  // eslint-disable-next-line no-console
  console.log(`GET ${RESOURCE_URL}`);
  // eslint-disable-next-line no-console
  console.log(`  wallet: ${WALLET_FILE}`);

  try {
    const res = await pay(RESOURCE_URL);
    const text = await res.text();
    // eslint-disable-next-line no-console
    console.log(`-> ${res.status}`);
    // eslint-disable-next-line no-console
    console.log(text);
  } catch (err) {
    if (err instanceof NoMatchingSecretError) {
      // eslint-disable-next-line no-console
      console.error(
        `\nNo unspent ${err.wats}-wat secret in ${WALLET_FILE}. ` +
          `Seed one of exactly that amount before retrying.`,
      );
      process.exit(2);
    }
    throw err;
  }
}

main();
