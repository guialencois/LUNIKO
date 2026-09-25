import type { ProviderCallOutcome } from "@/lib/execution/effects";

/**
 * MockExternalEffect — a FAKE provider for proving the Fase 10 protocol
 * without sending one real message, charging any money, or touching any
 * external account.
 *
 * TEST SUPPORT ONLY. Nothing on a production path imports this directory:
 * lib/execution/executors/index.ts does not register the mock executor, and
 * no route, worker or planner references it.
 *
 * THE LEDGER IS THE POINT. It records every request the fake provider
 * ACCEPTED — the stand-in for "what now exists in the outside world", the
 * message on the customer's phone. Scenarios are judged by the ledger, not
 * by what the engine believes happened: the property under test is "at most
 * one accepted request per logical operation", and when the engine cannot
 * know, the honest answer is the status `unknown`.
 *
 * The fake models the WORST case on purpose: it offers no idempotency at
 * all. It accepts every request it receives, even one carrying a key it has
 * already seen — like the WhatsApp Cloud API send endpoint, and unlike a
 * provider with idempotency keys. A duplicate therefore lands in the ledger
 * instead of being absorbed by the provider, which is what makes the
 * at-most-once property observable at all.
 */

export type MockBehavior =
  /** Accepted; the confirmation arrives. */
  | "success"
  /** Definitively rejected (a validation error, say). Nothing happened. */
  | "failure"
  /** Accepted, but the answer was lost: the adapter reports unknown. */
  | "timeout"
  /** Never reached the provider — and the adapter ALSO reports unknown.
   *  From the caller's side this is indistinguishable from "timeout", which
   *  is exactly why a timeout can never be recorded as a failure. */
  | "timeout_before_accept"
  /** The process dies after the point of no return was committed and before
   *  the request leaves: nothing accepted, and nobody will ever report. */
  | "crash_before_request"
  /** The provider accepts, and the process dies before recording it. */
  | "crash_after_request"
  /** The provider accepts; its answer arrives only when the test calls
   *  releaseLate() — typically after the execution was reclaimed. */
  | "late_success"
  /** The provider accepts, then the adapter throws (an unparseable
   *  response, say). A thrown call is not a failed call. */
  | "throw_after_accept"
  /** An adapter bug: claims success without a provider reference. */
  | "success_without_reference";

export interface AcceptedRequest {
  seq: number;
  /** Recorded only to COUNT per operation. The fake does not deduplicate on
   *  it — a real provider without idempotency keys would not either. */
  idempotencyKey: string;
  providerReference: string;
}

export class MockExternalEffect {
  private readonly accepted: AcceptedRequest[] = [];
  private readonly heldAnswers: Array<() => void> = [];
  private invocations = 0;

  /** Every request the fake provider accepted, in order. */
  get ledger(): readonly AcceptedRequest[] {
    return this.accepted;
  }

  /** How many times an adapter call was made at all, accepted or not. */
  get calls(): number {
    return this.invocations;
  }

  /** Accepted requests for one logical operation. The number that matters. */
  acceptedFor(idempotencyKey: string): number {
    return this.accepted.filter((a) => a.idempotencyKey === idempotencyKey).length;
  }

  /** A `perform` for ONE call, showing the given behaviour. */
  perform(behavior: MockBehavior): (idempotencyKey: string) => Promise<ProviderCallOutcome> {
    return async (idempotencyKey: string): Promise<ProviderCallOutcome> => {
      this.invocations++;
      switch (behavior) {
        case "success":
          return { kind: "succeeded", providerReference: this.accept(idempotencyKey) };
        case "failure":
          return {
            kind: "failed",
            code: "MOCK_REJECTED",
            message: "the mock provider rejected the request",
          };
        case "timeout":
          this.accept(idempotencyKey);
          return { kind: "unknown", reason: "timed out waiting for the provider" };
        case "timeout_before_accept":
          return { kind: "unknown", reason: "timed out waiting for the provider" };
        case "crash_before_request":
          return never();
        case "crash_after_request":
          this.accept(idempotencyKey);
          return never();
        case "late_success": {
          const providerReference = this.accept(idempotencyKey);
          return new Promise<ProviderCallOutcome>((resolve) => {
            this.heldAnswers.push(() => resolve({ kind: "succeeded", providerReference }));
          });
        }
        case "throw_after_accept":
          this.accept(idempotencyKey);
          throw new Error("could not parse the provider response");
        case "success_without_reference":
          this.accept(idempotencyKey);
          return { kind: "succeeded", providerReference: "" };
      }
    };
  }

  /** Delivers every answer held by a late_success call. */
  releaseLate(): void {
    for (const deliver of this.heldAnswers.splice(0)) deliver();
  }

  private accept(idempotencyKey: string): string {
    const seq = this.accepted.length + 1;
    const providerReference = `mock-msg-${seq}`;
    this.accepted.push({ seq, idempotencyKey, providerReference });
    return providerReference;
  }
}

/** A dead process never answers: the promise is simply never settled. */
function never(): Promise<ProviderCallOutcome> {
  return new Promise<ProviderCallOutcome>(() => {});
}
