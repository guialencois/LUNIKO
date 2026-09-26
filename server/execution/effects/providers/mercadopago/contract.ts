import type { ProviderCallOutcome } from "@/lib/execution/effects";

/**
 * FASE 10.5B-1 — THE CONTRACT OF THE MERCADO PAGO ADAPTER. NOTHING RUNS.
 *
 * Types, constants and pure, deterministic functions only. There is no
 * fetch, no HTTP client, no credential, no environment read, no header
 * object and no executor here — and nothing registers one. A future phase
 * (10.5B-2) writes the `perform` that uses this; this file only fixes what
 * that `perform` is allowed to send and how it must read the answer.
 *
 * THE OPERATION
 *   "create one payment at Mercado Pago" — POST https://api.mercadopago.com/v1/payments
 *   (official reference, "Criar pagamento"; see the ficha in
 *   docs/async-execution.md, Fase 10.5B-1, for every source).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE (Fase 10 adapter contract)
 *   succeeded  only on sufficient POSITIVE confirmation from the provider:
 *              a readable payment whose status is `approved`, whose id is a
 *              usable non-secret reference, and which echoes back the
 *              external_reference we sent;
 *   failed     only on a DEFINITIVE refusal that the provider identified
 *              with its own code: a payment `rejected` with a
 *              `status_detail`, or a 400/403 whose every cause code is on
 *              the documented, definitive list below;
 *   unknown    everything else. Timeout, network error, exception, 5xx,
 *              an unreadable or malformed body, a 2xx that is not
 *              `approved`/`rejected`, a 4xx we cannot pin to a documented
 *              definitive code, a reference that does not match.
 *   Uncertainty is never turned into `failed`.
 *
 * WHAT NEVER LEAVES THIS FILE IN AN OUTCOME
 *   Authorization, access token, cookie, credential, any header, the
 *   request or response body, the card token, card data, the payer's
 *   e-mail. An outcome carries only: the payment id (digits), a provider
 *   code (from a closed shape), and fixed text written here. Provider
 *   free text (`message`, cause `description`) is never copied — it is not
 *   ours to vouch for.
 */

// ---------------------------------------------------------------------------
// Operation identity
// ---------------------------------------------------------------------------

/** ExternalEffectSpec.operation for this adapter. */
export const MERCADOPAGO_CREATE_PAYMENT_OPERATION = "mercadopago.payment.create";

/** The one endpoint this contract describes. Not a URL anything calls here. */
export const MERCADOPAGO_CREATE_PAYMENT_ENDPOINT = {
  method: "POST",
  path: "/v1/payments",
} as const;

/**
 * The NAME of the header that carries the idempotency key (official
 * reference: required on POST /v1/payments and POST /v1/payments/{id}/refunds).
 * Only the name: this file never builds a header set.
 */
export const MERCADOPAGO_IDEMPOTENCY_HEADER_NAME = "X-Idempotency-Key";

/**
 * The runner's key: sha256 hex (server/execution/effects/effect-key.ts).
 * The contract refuses to send anything else as the idempotency key or as
 * the external_reference — a different value would identify something
 * other than the logical operation.
 */
const RUNNER_KEY = /^[0-9a-f]{64}$/;

export function isRunnerIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && RUNNER_KEY.test(value);
}

/**
 * external_reference, per the official reference: at most 64 characters,
 * only digits, letters, "-" and "_". The runner key (64 hex) satisfies it
 * exactly, which is why it is used as the external_reference: the payment
 * can then be found by that reference (GET /v1/payments/search) without
 * storing anything new.
 */
const EXTERNAL_REFERENCE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Request: internal -> Mercado Pago
// ---------------------------------------------------------------------------

/**
 * What an executor asks for. Amount in integer cents so no float ever
 * enters the identity of the operation.
 */
export interface MercadoPagoPaymentRequest {
  /** Integer cents, > 0. Sent as transaction_amount = cents / 100. */
  amountCents: number;
  /** e.g. "pix", "visa", "master". */
  paymentMethodId: string;
  /** Integer >= 1 (installments is required by the reference). */
  installments: number;
  /**
   * The card token created by Mercado Pago's own tokenization (required
   * for credit card, per the reference; single use). SECRET-GRADE for this
   * system: it goes to the provider body only — never into the effect
   * payload, the fingerprint or any outcome.
   */
  cardToken?: string;
  /** Personal data: provider body only — never in the effect payload. */
  payerEmail: string;
  description?: string;
}

/** The body POST /v1/payments receives. Built, never sent, by this file. */
export interface MercadoPagoPaymentBody {
  transaction_amount: number;
  payment_method_id: string;
  installments: number;
  token?: string;
  payer: { email: string };
  description?: string;
  external_reference: string;
  /** "Quando definido como TRUE, os pagamentos só podem ser aprovados ou
   *  rejeitados" (reference). Always true: fewer intermediate states means
   *  fewer outcomes that can only be `unknown`. Whether it applies to every
   *  payment method (e.g. Pix) is not documented in the source consulted. */
  binary_mode: true;
}

export type RequestValidation =
  | { ok: true; request: MercadoPagoPaymentRequest }
  | { ok: false; field: string; problem: string };

const CONTROL = /[\u0000-\u001f\u007f]/;
const PAYMENT_METHOD_ID = /^[a-z0-9_]{1,40}$/;
/** Local caps (the reference does not document limits for these fields). */
const DESCRIPTION_MAX = 256;
const EMAIL_MAX = 254; // reference: error 4051, "Payer.email must be shorter than 254 characters"
const TOKEN_MAX = 256;

function printable(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !CONTROL.test(value);
}

/**
 * Validates, never normalises (same rule as the businessKey): a request
 * that would need repairing is refused before anything could be sent.
 * Problems name the field only — never echo its value.
 */
export function validatePaymentRequest(input: unknown): RequestValidation {
  if (typeof input !== "object" || input === null) return { ok: false, field: "request", problem: "not an object" };
  const r = input as Record<string, unknown>;
  const allowed = new Set(["amountCents", "paymentMethodId", "installments", "cardToken", "payerEmail", "description"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return { ok: false, field: k, problem: "unknown field" };

  if (typeof r.amountCents !== "number" || !Number.isSafeInteger(r.amountCents) || r.amountCents <= 0) {
    return { ok: false, field: "amountCents", problem: "must be a positive integer number of cents" };
  }
  if (typeof r.paymentMethodId !== "string" || !PAYMENT_METHOD_ID.test(r.paymentMethodId)) {
    return { ok: false, field: "paymentMethodId", problem: "must be a provider payment method id" };
  }
  if (typeof r.installments !== "number" || !Number.isSafeInteger(r.installments) || r.installments < 1) {
    return { ok: false, field: "installments", problem: "must be an integer >= 1" };
  }
  if (r.cardToken !== undefined && !printable(r.cardToken, TOKEN_MAX)) {
    return { ok: false, field: "cardToken", problem: "must be the provider's card token as given" };
  }
  if (!printable(r.payerEmail, EMAIL_MAX) || !/^[^\s@]+@[^\s@]+$/.test(r.payerEmail)) {
    return { ok: false, field: "payerEmail", problem: "must be an e-mail address" };
  }
  if (r.description !== undefined && !printable(r.description, DESCRIPTION_MAX)) {
    return { ok: false, field: "description", problem: `must be 1-${DESCRIPTION_MAX} printable characters` };
  }
  return {
    ok: true,
    request: {
      amountCents: r.amountCents,
      paymentMethodId: r.paymentMethodId,
      installments: r.installments,
      ...(r.cardToken !== undefined ? { cardToken: r.cardToken as string } : {}),
      payerEmail: r.payerEmail,
      ...(r.description !== undefined ? { description: r.description as string } : {}),
    },
  };
}

/**
 * internal request -> the body Mercado Pago expects. The runner's
 * idempotency key doubles as the external_reference (see above); both are
 * the same value on every attempt of the same logical operation.
 */
export function toMercadoPagoPaymentBody(
  request: MercadoPagoPaymentRequest,
  idempotencyKey: string
): MercadoPagoPaymentBody {
  const checked = validatePaymentRequest(request);
  if (!checked.ok) throw new MercadoPagoContractError(`invalid payment request: ${checked.field} ${checked.problem}`);
  if (!isRunnerIdempotencyKey(idempotencyKey) || !EXTERNAL_REFERENCE.test(idempotencyKey)) {
    throw new MercadoPagoContractError("idempotency key is not the runner's key");
  }
  const r = checked.request;
  return {
    // Integer cents / 100 is the double nearest the 2-decimal value, and
    // JSON prints it back as that value (1999 -> 19.99).
    transaction_amount: r.amountCents / 100,
    payment_method_id: r.paymentMethodId,
    installments: r.installments,
    ...(r.cardToken !== undefined ? { token: r.cardToken } : {}),
    payer: { email: r.payerEmail },
    ...(r.description !== undefined ? { description: r.description } : {}),
    external_reference: idempotencyKey,
    binary_mode: true,
  };
}

/**
 * ExternalEffectSpec.payload for this operation: what must be the same
 * for the same logical operation, and NOTHING secret or personal — the
 * card token and the payer's e-mail stay out (the fingerprint is a hash,
 * and a low-entropy hash can be guessed).
 */
export function effectPayloadFor(request: MercadoPagoPaymentRequest): Record<string, unknown> {
  return {
    amountCents: request.amountCents,
    paymentMethodId: request.paymentMethodId,
    installments: request.installments,
    ...(request.description !== undefined ? { description: request.description } : {}),
  };
}

export class MercadoPagoContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MercadoPagoContractError";
  }
}

// ---------------------------------------------------------------------------
// Response: what the future adapter observed -> ProviderCallOutcome
// ---------------------------------------------------------------------------

/**
 * Everything a call can end as, from the adapter's side. The future
 * `perform` turns its fetch into exactly one of these — and hands over
 * ONLY status and parsed body: never headers, never the request.
 */
export type MercadoPagoObservation =
  /** Our deadline passed without an answer. The provider may have acted. */
  | { kind: "timeout" }
  /** Connection refused/reset, DNS, TLS... The request may have left. */
  | { kind: "network_error" }
  /** Something threw. Its message is never read (it can carry a token). */
  | { kind: "exception"; error: unknown }
  /** An HTTP answer whose body could not be parsed as JSON. */
  | { kind: "unreadable"; status: number }
  /** An HTTP answer with its parsed JSON body. */
  | { kind: "response"; status: number; body: unknown };

/**
 * 400 cause codes the reference documents for POST /v1/payments that are
 * DEFINITIVE refusals of the request itself (validation, invalid token,
 * missing X-Idempotency-Key...): the payment was not created.
 *
 * Deliberately NOT here, so they stay `unknown`:
 *   2004 "POST to Gateway Transactions API fail"   — an internal call failed
 *   2007 "Connection to Card Token API fail"        — an internal call failed
 *   6033 "User unavailable"                         — a state, not a refusal we can pin
 *   1000 "Number of rows exceeded the limits"       — not a payment-creation validation
 * The reference describes these as failures of a step, not as "nothing was
 * created"; without that, they are not evidence.
 */
export const DEFINITIVE_400_CAUSE_CODES: ReadonlySet<string> = new Set([
  "1", "3", "8", "23",
  "2002", "2006", "2009", "2034", "2059", "2062", "2067", "2072", "2077", "2123", "2131", "2198",
  "3000", "3001", "3003", "3004", "3005", "3006", "3007", "3008", "3009", "3010", "3011", "3012",
  "3013", "3014", "3015", "3016", "3017", "3018", "3019", "3020", "3021", "3022", "3023", "3024",
  "3025", "3026", "3027", "3028", "3029", "3030", "3031", "3032", "3033", "3034",
  "4000", "4001", "4002", "4003", "4004", "4005", "4006", "4012", "4013", "4015", "4016", "4017",
  "4018", "4019", "4020", "4021", "4022", "4023", "4024", "4025", "4026", "4027", "4028", "4029",
  "4033", "4037", "4038", "4039", "4050", "4051", "4292",
  "7523",
]);

/** 403 codes the reference documents for POST /v1/payments (caller not
 *  authorised): refused before any payment exists. */
export const DEFINITIVE_403_CAUSE_CODES: ReadonlySet<string> = new Set(["4", "3002", "pa_unauthorized_result_from_policies"]);

/**
 * A provider code as it may be stored: digits, or a lowercase identifier.
 * Anything else is not a code we can vouch for.
 */
const PROVIDER_CODE = /^(?:\d{1,6}|[a-z][a-z0-9_]{0,63})$/;

/** Payment id: the reference types it as Number. Stored as its digits. */
const PAYMENT_ID_DIGITS = /^[1-9]\d{0,19}$/;

/**
 * The payment id as a provider reference — only if it is unmistakably a
 * payment id: a positive safe integer (or its digits). Digits cannot be a
 * token, a header or a credential; anything else is not accepted as a
 * reference at all.
 */
export function providerReferenceFromPaymentId(id: unknown): string | null {
  if (typeof id === "number") {
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  }
  if (typeof id === "string" && PAYMENT_ID_DIGITS.test(id)) {
    const n = Number(id);
    return Number.isSafeInteger(n) ? id : null;
  }
  return null;
}

function codeOf(value: unknown): string | null {
  const s = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof s === "string" && PROVIDER_CODE.test(s) ? s : null;
}

/**
 * Cause codes of an error body. The error-body shape is NOT documented in
 * the source consulted (the reference lists codes and messages, not the
 * JSON around them): this reads `cause: [{ code }]` and nothing else, and
 * any other shape yields no codes — which can only lead to `unknown`.
 */
function causeCodes(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const cause = (body as Record<string, unknown>).cause;
  if (!Array.isArray(cause) || cause.length === 0) return null;
  const codes: string[] = [];
  for (const c of cause) {
    if (typeof c !== "object" || c === null) return null;
    const code = codeOf((c as Record<string, unknown>).code);
    if (code === null) return null;
    codes.push(code);
  }
  return codes;
}

const unknown = (reason: string): ProviderCallOutcome => ({ kind: "unknown", reason });

/** Fixed texts: nothing from the provider's free text is ever copied. */
export const REASONS = {
  timeout: "mercadopago: no answer within the deadline; the payment may exist",
  network: "mercadopago: the connection failed; the request may have reached the provider",
  exception: (className: string) => `mercadopago: the call ended without a usable response (${className})`,
  unreadable: (status: number) => `mercadopago: HTTP ${status} with an unreadable body`,
  serverError: (status: number) => `mercadopago: HTTP ${status}; the provider may have acted`,
  unexpectedStatus: (status: number) => `mercadopago: HTTP ${status} is not evidence of success or of a definitive refusal`,
  malformed: (status: number) => `mercadopago: HTTP ${status} with a body that is not a payment`,
  noReference: "mercadopago: a payment was reported without a usable payment id",
  referenceMismatch: "mercadopago: the payment does not carry the external_reference that was sent",
  notFinal: (id: string, status: string) =>
    `mercadopago: payment ${id} is ${status}, not approved or rejected; reconcile by id`,
  rejectedWithoutDetail: (id: string) => `mercadopago: payment ${id} rejected without a status_detail`,
  undocumentedError: (status: number) =>
    `mercadopago: HTTP ${status} without a documented definitive error code`,
} as const;

/** A class name, if it looks like one — never the message. */
function className(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
}

/** A thrown call is not a failed call — and its text is never kept. */
export function outcomeFromThrown(err: unknown): ProviderCallOutcome {
  return unknown(REASONS.exception(className(err)));
}

/** Only these statuses are read as a created payment at all. The
 *  reference text says 201; its schema lists 200. */
const PAYMENT_CREATED_STATUSES = new Set([200, 201]);

/**
 * The provider's status for one payment, read strictly. Values the
 * reference lists: pending, approved, authorized, in_process, in_mediation,
 * rejected, cancelled, refunded, charged_back. Only `approved` and
 * `rejected` are conclusive for "create a payment"; the others describe a
 * payment whose fate is not decided (or a lifecycle event that makes no
 * sense as the answer to a create) — `unknown`, with the id for
 * reconciliation.
 */
function classifyPayment(status: number, body: unknown, expectedExternalReference: string): ProviderCallOutcome {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return unknown(REASONS.malformed(status));
  const p = body as Record<string, unknown>;

  const reference = providerReferenceFromPaymentId(p.id);
  if (reference === null) return unknown(REASONS.noReference);

  // The payment must be OURS: the same external_reference we sent. A
  // different or missing one is not evidence about this operation.
  if (p.external_reference !== expectedExternalReference) return unknown(REASONS.referenceMismatch);

  const payStatus = typeof p.status === "string" && PROVIDER_CODE.test(p.status) ? p.status : null;
  if (payStatus === null) return unknown(REASONS.malformed(status));

  if (payStatus === "approved") return { kind: "succeeded", providerReference: reference };

  if (payStatus === "rejected") {
    const detail = codeOf(p.status_detail);
    if (detail === null) return unknown(REASONS.rejectedWithoutDetail(reference));
    return {
      kind: "failed",
      code: `rejected:${detail}`,
      message: `mercadopago: payment ${reference} rejected (${detail})`,
    };
  }

  return unknown(REASONS.notFinal(reference, payStatus));
}

function classifyError(status: number, body: unknown, allowed: ReadonlySet<string>): ProviderCallOutcome {
  const codes = causeCodes(body);
  // EVERY cause must be a documented definitive code; one we cannot vouch
  // for makes the whole answer unknown.
  if (codes === null || !codes.every((c) => allowed.has(c))) return unknown(REASONS.undocumentedError(status));
  const code = `http_${status}:${codes.join(",")}`;
  return { kind: "failed", code, message: `mercadopago: request refused by the provider (${code})` };
}

/**
 * THE MAPPING: what the adapter observed -> ProviderCallOutcome.
 * Pure and total: every input ends in exactly one outcome, and whatever
 * this function does not positively recognise is `unknown`.
 */
export function classifyPaymentObservation(
  observation: MercadoPagoObservation,
  expectedExternalReference: string
): ProviderCallOutcome {
  try {
    if (!isRunnerIdempotencyKey(expectedExternalReference)) {
      return unknown("mercadopago: no valid external_reference to compare the answer with");
    }
    if (typeof observation !== "object" || observation === null) return unknown("mercadopago: no observation");
    switch (observation.kind) {
      case "timeout":
        return unknown(REASONS.timeout);
      case "network_error":
        return unknown(REASONS.network);
      case "exception":
        return outcomeFromThrown(observation.error);
      case "unreadable":
        return unknown(REASONS.unreadable(safeStatus(observation.status)));
      case "response": {
        const status = safeStatus(observation.status);
        if (PAYMENT_CREATED_STATUSES.has(status)) return classifyPayment(status, observation.body, expectedExternalReference);
        if (status >= 500) return unknown(REASONS.serverError(status));
        if (status === 400) return classifyError(status, observation.body, DEFINITIVE_400_CAUSE_CODES);
        if (status === 403) return classifyError(status, observation.body, DEFINITIVE_403_CAUSE_CODES);
        // 401 (documented without a code), 404, 409, 429, other 2xx/3xx/4xx:
        // not evidence either way.
        return unknown(REASONS.unexpectedStatus(status));
      }
      default:
        return unknown("mercadopago: unrecognised observation");
    }
  } catch (err) {
    // A getter that throws, a proxy... still never an escape, never failed.
    return outcomeFromThrown(err);
  }
}

/** HTTP status as an integer 100..599, else 0 (which maps to unknown). */
function safeStatus(status: unknown): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}
