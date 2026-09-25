/**
 * EXTERNAL EFFECTS — the contract between an executor and the durable record
 * of an operation it performs outside this system (Fase 10).
 *
 * TYPES ONLY. Nothing here touches the database or imports runtime code, so
 * this file is safe to reference from the engine (lib/execution) without
 * dragging server code into it. The implementation lives in
 * server/execution/effects/ and reaches executors through
 * NodeExecutionContext.effects, injected by the worker.
 *
 * THREE THINGS THAT ARE EASY TO CONFUSE
 *
 *   logical operation   "send template X to lead 42, in this execution".
 *                       One per identity. Survives every reclaim.
 *   attempt             one epoch trying to make that operation happen.
 *                       One per epoch that tried.
 *   external effect     what actually exists in the outside world — the
 *                       message on the customer's phone. Zero, one, or MORE.
 *
 * Fencing and the lease control ATTEMPTS. Neither of them touches EFFECTS.
 * This layer exists to keep effects at one per logical operation where that
 * is possible — and to say so plainly where it is not.
 */

/**
 * How an operation behaves when its outcome cannot be known.
 *
 * Only AT_MOST_ONCE exists in this phase, deliberately: once any attempt has
 * crossed the point of no return, no later attempt may send again. The cost
 * is honest — a message whose worker died mid-call may never be delivered,
 * and the operation stays "unknown" until someone resolves it. The
 * alternative (resend on doubt) duplicates, and for a provider without an
 * idempotency key there is no third option.
 *
 * Policies that could exist later (at-least-once, provider-idempotent,
 * reconcilable-by-lookup) are intentionally not modelled yet.
 */
export type DeliveryPolicy = "at_most_once";

/**
 * What a provider adapter reports about ONE call it made.
 *
 * THE ADAPTER CONTRACT, which every real integration must honour:
 *   succeeded  the provider confirmed, and returned a non-secret reference
 *              (a message id, a payment id). Without one it is recorded as
 *              unknown — never as a success without evidence.
 *   failed     the provider DEFINITIVELY rejected the request, so nothing
 *              happened externally — e.g. a validation error. Only this,
 *              and with the provider's own error code (without one it is
 *              recorded as unknown: "nothing happened" needs evidence too).
 *   unknown    anything else: timeout, connection reset, a 5xx, a response
 *              that could not be parsed. "The provider may or may not have
 *              acted." A timeout is NOT a failure: it is exactly the case
 *              where the provider accepted and the answer was lost.
 *
 * When an adapter is unsure which of these applies, the answer is unknown.
 * `code`, `message` and `reason` are stored: they must never contain a
 * token, a header or a payload. (The runner never stores exception text
 * for the same reason — a thrown error keeps only its class name.)
 */
export type ProviderCallOutcome =
  | { kind: "succeeded"; providerReference: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "unknown"; reason: string };

export interface ExternalEffectSpec {
  /** What kind of operation this is, e.g. "whatsapp.send_template". */
  operation: string;
  /**
   * The business entity this operation affects — e.g. a lead id. REQUIRED.
   * Never an item index: an index silently points at a different entity the
   * moment anything upstream stops being deterministic. Must be an
   * identifier, never a credential; prefer internal ids over raw personal
   * data such as phone numbers.
   */
  businessKey: string;
  /**
   * The request's NON-SECRET content. It is never stored — only a hash of
   * it is, to detect the same identity being asked to do something
   * different (the signature of non-determinism upstream).
   */
  payload: Record<string, unknown>;
  /**
   * The actual call. Runs OUTSIDE any database transaction, and receives the
   * operation's stable idempotency key to forward to providers that accept
   * one. A thrown error is treated as `unknown`, never as `failed`. Bounded
   * by the runner's deadline (EFFECT_CALL_TIMEOUT_MS): past it the outcome
   * is recorded as `unknown`, and an answer that still arrives later is
   * recorded as the fact it is.
   */
  perform: (idempotencyKey: string) => Promise<ProviderCallOutcome>;
}

export type ExternalEffectResult =
  /** replayed=true: an earlier attempt already did this; nothing was sent now. */
  | { status: "succeeded"; providerReference: string; replayed: boolean }
  | { status: "failed"; code: string; message: string; replayed: boolean }
  /** The effect may or may not exist. Not a failure, not a retry signal. */
  | { status: "unknown"; reason: string }
  /** This attempt no longer owns the execution. Stop; nothing was sent. */
  | { status: "fenced" }
  /** Same identity, different request. Refused; nothing was sent. */
  | { status: "payload_mismatch" }
  /** Could not settle the operation's state. Nothing was sent. */
  | { status: "not_attempted"; reason: string };

/**
 * The only sanctioned way for an executor to cause an external effect.
 * Bound by the worker to one execution and one claim epoch.
 */
export interface EffectRunner {
  run(nodeId: string, spec: ExternalEffectSpec): Promise<ExternalEffectResult>;
}
