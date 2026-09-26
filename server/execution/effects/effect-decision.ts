/**
 * THE DECISION TABLE for one attempt facing one logical operation.
 *
 * Pure on purpose: it is the whole state machine in one place, testable
 * without a database. But it decides from a SNAPSHOT, which can be stale by
 * the time anything acts on it — so it never is the barrier. Every
 * transition it recommends is carried out by a conditional write in
 * effect-repository.ts that re-checks the same conditions against the row's
 * current state, and the runner simply re-reads and asks again when a write
 * finds the world has moved.
 *
 * THE RULE UNDERNEATH: fence decisions by ownership, fence facts by
 * authorship.
 *
 *   decisions  — reserve, adopt, begin a call — belong to whoever owns the
 *                execution NOW. A superseded epoch may not make them.
 *   facts      — "the provider confirmed my call" — belong to whoever MADE
 *                that call, and are recorded even after ownership moved.
 *
 * Applying ownership-fencing to facts is the subtle bug this avoids: it
 * would discard a late provider confirmation from a superseded worker,
 * leave the operation looking unsent, and cause precisely the duplicate
 * that fencing is meant to prevent. Reproduced against PostgreSQL before
 * this was written.
 */

export type EffectStatus = "reserved" | "in_flight" | "succeeded" | "failed" | "unknown";

export interface EffectOperationSnapshot {
  status: EffectStatus;
  ownerEpoch: number;
  beganEpoch: number | null;
  payloadFingerprint: string;
  providerReference: string | null;
  lastError: { code: string; message: string } | null;
}

export type EffectDecision =
  /** Nothing exists for this identity yet. */
  | { kind: "reserve" }
  /** A newer epoch owns this operation: I have been superseded. Stop. */
  | { kind: "fenced" }
  /** Same identity, different request. Refuse — do not send. */
  | { kind: "payload_mismatch" }
  | { kind: "replay_succeeded"; providerReference: string }
  | { kind: "replay_failed"; code: string; message: string }
  /** Ambiguous and permanent until someone resolves it. Do not send. */
  | { kind: "report_unknown" }
  /** An older epoch owns it and never finished. Take it over; the database
   *  decides whether that means "safe to proceed" (it had only reserved) or
   *  "unknown" (it had already crossed the point of no return). */
  | { kind: "adopt" }
  /** I own it, and nothing has been sent. Cross the point of no return. */
  | { kind: "begin" }
  /** I own it and I already crossed the point of no return in this very
   *  epoch, but no outcome was recorded. I cannot know what happened. */
  | { kind: "reentered_in_flight" };

export function decideEffectAction(
  op: EffectOperationSnapshot | null,
  myEpoch: number,
  myFingerprint: string
): EffectDecision {
  if (op === null) return { kind: "reserve" };

  // Ownership first: a superseded epoch gets no information it could act on.
  if (op.ownerEpoch > myEpoch) return { kind: "fenced" };

  // Then identity: the same key asked to do something different is refused
  // before any replay — replaying a result for a DIFFERENT request would
  // report an effect that was never requested.
  if (op.payloadFingerprint !== myFingerprint) return { kind: "payload_mismatch" };

  switch (op.status) {
    case "succeeded":
      return { kind: "replay_succeeded", providerReference: op.providerReference ?? "" };
    case "failed":
      return {
        kind: "replay_failed",
        code: op.lastError?.code ?? "EXTERNAL_EFFECT_FAILED",
        message: op.lastError?.message ?? "The external operation failed",
      };
    case "unknown":
      return { kind: "report_unknown" };
    case "reserved":
      return op.ownerEpoch < myEpoch ? { kind: "adopt" } : { kind: "begin" };
    case "in_flight":
      return op.ownerEpoch < myEpoch ? { kind: "adopt" } : { kind: "reentered_in_flight" };
  }
}
