// x402 v2 core types (subset) plus webcash-specific shapes.
// See specs/scheme_webcash.md and the x402 v2 specification for field semantics.

export type ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
};

export type PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
};

export type PaymentRequired = {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

export type WebcashPayload = {
  secret: string;
};

export type PaymentPayload<P = unknown> = {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: P;
  extensions?: Record<string, unknown>;
};

export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
};

export type SettlementResponse = {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: Record<string, unknown>;
};

export type SupportedKind = {
  x402Version: 2;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
};

export type SupportedResponse = {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
};

export type FacilitatorRequest = {
  x402Version: 2;
  paymentPayload: PaymentPayload<WebcashPayload>;
  paymentRequirements: PaymentRequirements;
};
