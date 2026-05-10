export * from "./types.js";
export {
  DEFAULT_LEGALESE,
  KNOWN_NETWORKS,
  issuerHealth,
  newOutputSecret,
  parseSecret,
  replaceSecret,
  secretFingerprint,
  watsToDecimal,
} from "./webcash.js";
export type { IssuerHealth, ParsedSecret, ReplaceResult } from "./webcash.js";
export { Facilitator } from "./facilitator.js";
export type { FacilitatorOptions } from "./facilitator.js";
export { paywall } from "./middleware.js";
export type { PaywallOptions, WebcashOutput } from "./middleware.js";
// Client-side scheme handler (also exported via the `x402-webcash/client`
// subpath for consumers that want to import only the client surface).
export {
  buildWebcashHeader,
  FileWallet,
  MemoryWallet,
  NoMatchingSecretError,
  WEBCASH_SCHEME,
  wrapFetchWithWebcash,
} from "./client/index.js";
export type { BuiltHeader, Wallet, WrapFetchOptions } from "./client/index.js";
