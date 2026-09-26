import type {
  EffectRunner,
  ExternalEffectResult,
  ExternalEffectSpec,
  ProviderCallOutcome,
} from "@/lib/execution/effects";
import { decideEffectAction } from "./effect-decision";
import {
  deriveIdempotencyKey,
  fingerprintPayload,
  validateBusinessKey,
  validateOperation,
} from "./effect-key";
import {
  adoptEffectOperation,
  beginEffectOperation,
  getEffectOperationByKey,
  recordEffectOutcome,
  reserveEffectOperation,
  toSnapshot,
} from "./effect-repository";

/**
 * THE PROTOCOL, for one logical external operation:
 *
 *   TX1  reserve   create the operation, or find it           [commit]
 *   TX2  begin     reserved -> in_flight, once, ever           [commit]
 *        CALL      perform(idempotencyKey) — NO transaction open
 *   TX3  record    the provider's answer, as a fact            [commit]
 *
 * WHY THE CALL IS NEVER INSIDE A TRANSACTION
 * It is tempting to open a transaction, make the call, and commit only if
 * it worked, as if that made the two atomic. It does not:
 *   1. The provider does not take part in our transaction. If our commit
 *      fails after it accepted, the effect exists and the record does not —
 *      the very case this layer exists for, only now hidden.
 *   2. This project runs with ONE database connection per process
 *      (lib/db/index.ts, max: 1). A transaction held open across a slow
 *      network call blocks the lease heartbeat and every other query of
 *      this worker for as long as the provider takes.
 *   3. Behind Supavisor in transaction mode, an open transaction pins a
 *      physical connection for its whole duration.
 * So the transactions are three short ones, and the call sits between the
 * second and third with nothing held.
 *
 * WHAT GOES INTO THE RECORD
 * Only what the adapter can vouch for: a success with a usable reference, a
 * failure with the provider's error code, and otherwise "unknown". Never
 * the text of an exception — it can carry a token (see thrownOutcome).
 *
 * WHY "BEGIN" COMMITS BEFORE THE CALL, NOT AFTER
 * A crash between call and record must not leave a sent message looking
 * unsent. Committing in_flight first means the only possible error is the
 * safe one: a crash after the commit and before the call looks ambiguous
 * even though nothing left. False doubt is recoverable by a human; false
 * safety is a duplicate.
 *
 * WHAT THIS DOES NOT PROMISE
 * With a provider that offers no idempotency key — the WhatsApp Cloud API
 * send endpoint is one, verified in Meta's reference — there is no
 * exactly-once. This runner implements AT-MOST-ONCE: after any attempt
 * crosses the point of no return, no attempt sends again, and an outcome
 * nobody observed stays "unknown" until a person resolves it — or until the
 * call's own answer arrives late, which replaces even that person's
 * judgment (see recordEffectOutcome). A provider
 * that DOES accept a key (Mercado Pago's X-Idempotency-Key, on Payments and
 * Refunds) receives the same stable key on every attempt — but what that
 * buys is whatever that provider guarantees for its keys, for as long as it
 * retains them. It is the provider's property, not this engine's, and
 * nothing here claims otherwise.
 */

/** Rounds of "read, decide, try" before giving up without sending. Each
 *  round normally makes progress (reserve -> own it -> begin), so this is a
 *  guard against a pathological race, not a retry budget. */
const MAX_SETTLE_ROUNDS = 5;

/** Recording a fact is a local database write, so retrying it is safe in a
 *  way that retrying the call never is. It is also the one moment this
 *  process holds information nothing else has — worth a few attempts before
 *  letting a transient database error turn a known outcome into doubt. */
const RECORD_ATTEMPTS = 3;

/**
 * How long one provider call may take before its outcome is recorded as
 * `unknown` and the node moves on. Without it a hung call would keep the
 * operation in_flight — and the heartbeat renewing the lease — for as long
 * as the process lives.
 *
 * THIS IS THE END OF OUR WAIT, NOT A CANCELLATION OF THE EFFECT. The call is
 * not aborted when this passes, and the provider may still complete it; if
 * the answer arrives, it is recorded as the fact it is (see below). An
 * executor must never read "past the deadline" as "did not happen".
 */
export const EFFECT_CALL_TIMEOUT_MS = 20_000;

/** Caps for what an adapter hands back. Stored text is short, printable
 *  and valid for PostgreSQL's jsonb. */
const MAX_TEXT_LENGTH = 500;
const MAX_CODE_LENGTH = 100;
const MAX_REFERENCE_LENGTH = 256;

export interface EffectBinding {
  executionId: string;
  workspaceId: string;
  epoch: number;
  /** Defaults to EFFECT_CALL_TIMEOUT_MS. */
  callTimeoutMs?: number;
}

// Unpaired surrogates (e.g. a string cut in the middle of an emoji) and NUL
// are rejected by PostgreSQL's jsonb — a definitive outcome would then fail
// to record and decay into "unknown". Control characters make log lines lie.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value: string, max: number): string {
  return value.slice(0, max).replace(LONE_SURROGATE, "\uFFFD").replace(CONTROL_CHARS, " ");
}

/** A reference is evidence: it is used as-is or not at all, never repaired. */
function usableReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REFERENCE_LENGTH &&
    cleanText(value, MAX_REFERENCE_LENGTH) === value
  );
}

/**
 * An adapter bug must never become a recorded outcome without evidence.
 *   succeeded  needs a usable provider reference, or it is unknown;
 *   failed     is as strong a claim as success ("nothing happened"), so it
 *              needs the provider's own error code, or it is unknown;
 *   anything else is unknown.
 * Text is cleaned and capped; it is still the adapter's job never to put a
 * secret in it (docs/async-execution.md, "Contrato do adaptador").
 */
function sanitize(outcome: unknown): ProviderCallOutcome {
  if (typeof outcome !== "object" || outcome === null) {
    return { kind: "unknown", reason: "the provider adapter returned no outcome" };
  }
  const o = outcome as Record<string, unknown>;
  if (o.kind === "succeeded") {
    return usableReference(o.providerReference)
      ? { kind: "succeeded", providerReference: o.providerReference }
      : { kind: "unknown", reason: "the provider reported success without a usable reference" };
  }
  if (o.kind === "failed") {
    if (typeof o.code !== "string" || o.code.trim().length === 0) {
      return { kind: "unknown", reason: "the provider adapter reported a failure without a provider error code" };
    }
    return {
      kind: "failed",
      code: cleanText(o.code, MAX_CODE_LENGTH),
      message:
        typeof o.message === "string"
          ? cleanText(o.message, MAX_TEXT_LENGTH)
          : "The provider rejected the request",
    };
  }
  if (o.kind === "unknown") {
    return { kind: "unknown", reason: typeof o.reason === "string" ? cleanText(o.reason, MAX_TEXT_LENGTH) : "unknown" };
  }
  return { kind: "unknown", reason: "the provider adapter returned an unrecognised outcome" };
}

/**
 * A thrown call is NOT a failed call: the request may well have reached the
 * provider before whatever threw. And the exception's MESSAGE is never kept:
 * it can carry whatever the request carried — the review of this phase
 * reproduced fetch rejecting an invalid Authorization header value with the
 * token inside the message. Only the error's class name survives, and only
 * if it looks like one.
 */
function thrownOutcome(err: unknown): ProviderCallOutcome {
  const name = err instanceof Error ? err.name : typeof err;
  const kind = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : "Error";
  return { kind: "unknown", reason: `the call ended without a usable response (${kind})` };
}

function toResult(outcome: ProviderCallOutcome): ExternalEffectResult {
  switch (outcome.kind) {
    case "succeeded":
      return { status: "succeeded", providerReference: outcome.providerReference, replayed: false };
    case "failed":
      return { status: "failed", code: outcome.code, message: outcome.message, replayed: false };
    case "unknown":
      return { status: "unknown", reason: outcome.reason };
  }
}

async function recordWithRetry(
  operationId: string,
  executionId: string,
  epoch: number,
  outcome: ProviderCallOutcome
) {
  let lastError: unknown;
  for (let i = 0; i < RECORD_ATTEMPTS; i++) {
    try {
      return await recordEffectOutcome({ operationId, executionId, epoch, outcome });
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  // Out of attempts. The operation stays in_flight in the database and will
  // read as "unknown" to the next owner (or when the execution ends) —
  // conservative, never a duplicate. Throwing makes this node fail loudly
  // instead of reporting an outcome the durable record does not agree with.
  throw lastError;
}

/**
 * Makes the call, bounded by `timeoutMs`. Past the deadline the outcome is
 * `unknown` — but the call is left running rather than aborted, because
 * aborting a request that may already be on the wire only guarantees we
 * never learn how it ended. If it answers later, `onLateAnswer` receives the
 * answer: a fact from this epoch like any other.
 */
async function callProvider(
  spec: ExternalEffectSpec,
  idempotencyKey: string,
  timeoutMs: number,
  onLateAnswer: (outcome: ProviderCallOutcome) => void
): Promise<ProviderCallOutcome> {
  // .catch AFTER sanitize: whatever goes wrong — the call throwing, or an
  // answer too malformed even to inspect — ends as unknown, never as an
  // exception escaping after the point of no return.
  const call: Promise<ProviderCallOutcome> = Promise.resolve()
    .then(() => spec.perform(idempotencyKey))
    .then(sanitize)
    .catch(thrownOutcome);

  // Deliberately NOT unref'd, unlike the heartbeat timer: the heartbeat is
  // background work, but this deadline is what the caller is waiting on — an
  // unref'd deadline never fires when nothing else holds the event loop
  // open. It is always cleared below when the call answers first.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), timeoutMs);
  });

  const first = await Promise.race([call, deadline]);
  clearTimeout(timer);
  if (first !== "deadline") return first;

  void call.then((late) => {
    if (late.kind !== "unknown") onLateAnswer(late);
  });
  return { kind: "unknown", reason: `no answer from the provider within ${timeoutMs}ms` };
}

export function createEffectRunner(binding: EffectBinding): EffectRunner {
  const timeoutMs = binding.callTimeoutMs ?? EFFECT_CALL_TIMEOUT_MS;

  /**
   * Runs of the same operation that are in progress in THIS runner (one
   * epoch, one process). An executor that runs two items for the same
   * entity concurrently gets one attempt, shared: without this the second
   * one lost the race to `begin`, found its own epoch's call in flight, and
   * reported "unknown" about an operation that then succeeded. Across
   * processes the database is the barrier; this only removes the spurious
   * doubt within one.
   */
  const inProgress = new Map<string, { fingerprint: string; result: Promise<ExternalEffectResult> }>();

  async function settle(
    nodeId: string,
    spec: ExternalEffectSpec,
    businessKey: string,
    operation: string,
    idempotencyKey: string,
    fingerprint: string
  ): Promise<ExternalEffectResult> {
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      const row = await getEffectOperationByKey(idempotencyKey);
      const decision = decideEffectAction(row ? toSnapshot(row) : null, binding.epoch, fingerprint);

      switch (decision.kind) {
        case "reserve": {
          const reserved = await reserveEffectOperation({
            executionId: binding.executionId,
            workspaceId: binding.workspaceId,
            nodeId,
            businessKey,
            operation,
            idempotencyKey,
            payloadFingerprint: fingerprint,
            epoch: binding.epoch,
          });
          if (reserved.outcome === "fenced") return { status: "fenced" };
          // Inserted or found: either way, decide again on committed state.
          continue;
        }

        case "fenced":
          return { status: "fenced" };

        case "payload_mismatch":
          return { status: "payload_mismatch" };

        case "replay_succeeded":
          return { status: "succeeded", providerReference: decision.providerReference, replayed: true };

        case "replay_failed":
          return { status: "failed", code: decision.code, message: decision.message, replayed: true };

        case "report_unknown":
          return {
            status: "unknown",
            reason: "an earlier attempt may have reached the provider; this operation needs explicit resolution",
          };

        case "reentered_in_flight":
          return {
            status: "unknown",
            reason: "this attempt already crossed the point of no return without recording an outcome",
          };

        case "adopt": {
          const adopted = await adoptEffectOperation({
            operationId: row!.id,
            executionId: binding.executionId,
            epoch: binding.epoch,
          });
          if (adopted.outcome === "fenced") return { status: "fenced" };
          // Now mine — as "reserved" (safe to go on) or "unknown" (stop).
          // The next round's read says which.
          continue;
        }

        case "begin": {
          const began = await beginEffectOperation({
            operationId: row!.id,
            executionId: binding.executionId,
            epoch: binding.epoch,
          });
          if (began.outcome === "fenced") return { status: "fenced" };
          if (began.outcome === "stale") continue;

          // ---- The point of no return has been crossed AND committed. ----
          // From here on, the only thing that may be written about this
          // operation by this attempt is the fact of what the provider said.
          const operationId = began.op.id;
          const outcome = await callProvider(spec, idempotencyKey, timeoutMs, (late) => {
            // Best effort: a process that ends first loses it, and the
            // operation stays unknown until a person resolves it.
            recordWithRetry(operationId, binding.executionId, binding.epoch, late).catch(() => {});
          });

          await recordWithRetry(operationId, binding.executionId, binding.epoch, outcome);
          return toResult(outcome);
        }
      }
    }

    return {
      status: "not_attempted",
      reason: "could not settle the operation's state; nothing was sent",
    };
  }

  return {
    async run(nodeId: string, spec: ExternalEffectSpec): Promise<ExternalEffectResult> {
      // Identity first. A missing businessKey is refused here — before any
      // row exists and long before any call.
      const businessKey = validateBusinessKey(spec.businessKey);
      const operation = validateOperation(spec.operation);
      const idempotencyKey = deriveIdempotencyKey({
        executionId: binding.executionId,
        nodeId,
        businessKey,
        operation,
      });
      const fingerprint = fingerprintPayload(spec.payload);

      const running = inProgress.get(idempotencyKey);
      if (running) {
        if (running.fingerprint !== fingerprint) return { status: "payload_mismatch" };
        const shared = await running.result;
        // Nothing was sent by THIS call.
        return shared.status === "succeeded" || shared.status === "failed"
          ? { ...shared, replayed: true }
          : shared;
      }

      const result = settle(nodeId, spec, businessKey, operation, idempotencyKey, fingerprint);
      inProgress.set(idempotencyKey, { fingerprint, result });
      try {
        return await result;
      } finally {
        inProgress.delete(idempotencyKey);
      }
    },
  };
}
