/**
 * FASE 10.5B-1 — WHAT MERCADO PAGO DOCUMENTS, AS DATA. NOT A POLICY.
 *
 * This is a declarative record of the provider's DOCUMENTED capabilities,
 * each with the official source it was read from (consulted 2026-09-25;
 * the ficha in docs/async-execution.md is the human-readable version).
 *
 * WHAT THIS IS NOT
 *   - Not a policy of the Engine. Nothing outside
 *     server/execution/effects/providers/mercadopago/ may import this file
 *     in this phase (checked by scripts/effects-spec/mercadopago/isolation.mjs).
 *   - Not an operational guarantee. "The provider documents X" is not "this
 *     system relies on X". The database accepts only `at_most_once`
 *     (migration 0006); nothing here widens that.
 *
 * `null` means: NOT DOCUMENTED in the source consulted. It never means
 * "no", "unlimited" or "default".
 */

const SOURCES = {
  createPayment:
    "https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/create-payment/post",
  createRefund:
    "https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/create-refund/post",
  getPayment:
    "https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/get-payment/get",
  searchPayments:
    "https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api-payments/search-payments/get",
  idempotencyNews:
    "https://www.mercadopago.com.br/developers/en/news/2023/01/04/Idempotency-key-usage-will-be-mandatory",
  notifications:
    "https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications",
} as const;

export const MERCADOPAGO_CAPABILITIES = {
  provider: "mercadopago",
  consultedOn: "2026-09-25",

  idempotency: {
    acceptsKey: true,
    headerName: "X-Idempotency-Key",
    /** Where the reference marks the header as required. */
    operations: [
      { method: "POST", path: "/v1/payments", source: SOURCES.createPayment },
      { method: "POST", path: "/v1/payments/{id}/refunds", source: SOURCES.createRefund },
    ],
    /** "the server can recognize duplicated requests and ensure that only
     *  the first one is processed" */
    sameKeyBehavior: "only the first request is processed",
    sameKeyBehaviorSource: SOURCES.idempotencyNews,
    /** What the second request RECEIVES back: not documented. */
    sameKeyResponse: null,
    /** How long a key is honoured: not documented. */
    keyRetention: null,
    /** Same key, different body: not documented. */
    sameKeyDifferentBody: null,
    /** Key format/length limits: only "UUID V4 ou strings randômicas" is suggested. */
    keyFormatLimits: null,
    keyFormatSuggestionSource: SOURCES.createPayment,
  },

  reconciliation: {
    byPaymentId: { method: "GET", path: "/v1/payments/{id}", source: SOURCES.getPayment },
    byExternalReference: {
      method: "GET",
      path: "/v1/payments/search",
      queryParameter: "external_reference",
      /** "retorna os pagamentos efetuados nos últimos doze meses" */
      lookbackWindow: "12 months",
      source: SOURCES.searchPayments,
    },
    /** external_reference: max 64 characters, [A-Za-z0-9_-]. */
    externalReferenceLimits: { maxLength: 64, charset: "A-Za-z0-9_-" },
    externalReferenceLimitsSource: SOURCES.createPayment,
  },

  lateConfirmation: {
    webhook: true,
    /** The receiver must answer 200/201 within this; otherwise retried. */
    ackTimeoutSeconds: 22,
    /** Documented delays of delivery attempts after a missed ack. */
    retryDelays: ["0 min", "15 min", "30 min", "6 h", "48 h", "96 h", "96 h", "96 h"],
    /** "Após a terceira tentativa, o prazo será prorrogado, mas os envios
     *  continuarão acontecendo" — no end of the window is documented. */
    totalWindow: null,
    /** The time between a payment being created and its FIRST notification: not documented. */
    firstNotificationDelay: null,
    source: SOURCES.notifications,
  },

  providerReference: {
    field: "id",
    /** The reference types it as Number, "gerado automaticamente pelo Mercado Pago". */
    type: "number",
    source: SOURCES.createPayment,
  },
} as const;
