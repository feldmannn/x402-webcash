export * from "./types.js";
export {
  DEFAULT_LEGALESE,
  KNOWN_NETWORKS,
  decimalToWats,
  issuerHealth,
  newOutputSecret,
  parseSecret,
  replaceSecret,
  secretFingerprint,
  watsToDecimal,
} from "./webcash.js";
export type { IssuerHealth, ParsedSecret, ReplaceResult } from "./webcash.js";
export { Facilitator, isAcceptableIssuerScheme } from "./facilitator.js";
export type { FacilitatorOptions } from "./facilitator.js";
export { paywall } from "./middleware.js";
export type { PaywallOptions, WebcashOutput } from "./middleware.js";
export { webcashSettler } from "./mcp-settler.js";
// Client-side scheme handler (also exported via the `x402-webcash/client`
// subpath for consumers that want to import only the client surface).
export {
  AmbiguousSplitError,
  buildWebcashHeader,
  FileWallet,
  InsecureIssuerError,
  IssuerRejectedSplitError,
  MemoryWallet,
  NoMatchingSecretError,
  NoSplittableSecretError,
  splitToMatch,
  WEBCASH_SCHEME,
  wrapFetchWithWebcash,
} from "./client/index.js";
export type {
  AutoSplitOptions,
  BuildHeaderOptions,
  BuiltHeader,
  SplitOptions,
  Wallet,
  WrapFetchOptions,
} from "./client/index.js";
