import { db } from "@/lib/db";
import { executions, effectOperations, effectAttempts, workflows } from "@/lib/db/schema";
import type { EffectOperationRow } from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { requireWorkspaceMembership } from "@/lib/auth/session";
import type { ProviderCallOutcome } from "@/lib/execution/effects";
import type { EffectOperationSnapshot, EffectStatus } from "./effect-decision";
import {
  RESOLUTION_COOLING_PERIOD_SECONDS,
  RESOLVER_ROLES,
  TERMINAL_EXECUTION_STATUSES,
  statusForResolution,
  type ResolveEffectInput,
} from "./resolution";

/**
 * Every transition of an external operation, each as ONE short transaction
 * whose WHERE clause is the real barrier. effect-decision.ts recommends;
 * this file decides, against the row's current state, under a row lock.
 *
 * THE TWO FENCES, and why they differ
 *
 *   Decisions (reserve, adopt, begin) require that the calling epoch still
 *   OWNS THE EXECUTION: `executions` row with runner='worker',
 *   status='running' and claim_attempts = epoch, read FOR SHARE inside the
 *   same transaction. FOR SHARE is what makes the check hold until commit:
 *   a concurrent reclaim needs to UPDATE that row, so it waits for us rather
 *   than moving ownership between our check and our write. A superseded
 *   worker therefore cannot reserve a new operation, cannot take one over,
 *   and above all cannot cross the point of no return.
 *
 *   Facts (recordEffectOutcome) require only AUTHORSHIP: the operation's
 *   execution and began_epoch are the reporter's. Nothing else. Ownership is
 *   deliberately NOT checked: "the provider confirmed my call" is true
 *   regardless of who owns the execution now, and discarding it is how a
 *   superseded worker's real message gets sent a second time. (The
 *   execution is part of authorship because epoch numbers repeat across
 *   executions — every first claim is epoch 1.)
 *
 *   Every conditional write also carries its conditions in the UPDATE's own
 *   WHERE, under the row lock, and the database refuses any transition the
 *   state machine does not allow (trigger effect_operations_guard, 0006) —
 *   so the at-most-once property does not depend on this file alone.
 *
 * NO NETWORK CALL EVER HAPPENS INSIDE THESE TRANSACTIONS. The call sits
 * between beginEffectOperation's commit and recordEffectOutcome — see
 * effect-runner.ts for why that ordering, and why never inside.
 *
 * MODELO 2 (worker) for everything except the two functions at the bottom,
 * which are MODELO 1 (a live user, membership re-checked).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function toSnapshot(row: EffectOperationRow): EffectOperationSnapshot {
  const err = row.lastError as { code?: unknown; message?: unknown } | null;
  return {
    status: row.status as EffectStatus,
    ownerEpoch: row.ownerEpoch,
    beganEpoch: row.beganEpoch,
    payloadFingerprint: row.payloadFingerprint,
    providerReference: row.providerReference,
    lastError:
      err && typeof err.code === "string" && typeof err.message === "string"
        ? { code: err.code, message: err.message }
        : null,
  };
}

/** Ownership check for DECISIONS. Must run inside the deciding transaction. */
async function executionOwnedBy(tx: Tx, executionId: string, epoch: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.runner, "worker"),
        eq(executions.status, "running"),
        eq(executions.claimAttempts, epoch)
      )
    )
    .limit(1)
    .for("share");
  return Boolean(row);
}

async function lockOperation(tx: Tx, operationId: string) {
  const [op] = await tx
    .select()
    .from(effectOperations)
    .where(eq(effectOperations.id, operationId))
    .limit(1)
    .for("update");
  return op ?? null;
}

export async function getEffectOperationByKey(idempotencyKey: string) {
  const [op] = await db
    .select()
    .from(effectOperations)
    .where(eq(effectOperations.idempotencyKey, idempotencyKey))
    .limit(1);
  return op ?? null;
}

/**
 * Result of a DECISION on an existing operation.
 *   fenced  this epoch no longer owns the execution — stop, nothing sent.
 *   stale   the operation moved since it was read — re-read and decide again.
 *   done    the transition happened.
 * Distinguishing the first two matters: retrying a fenced decision would
 * spin until the round limit instead of stopping at once.
 */
export type TransitionResult =
  | { outcome: "fenced" }
  | { outcome: "stale" }
  | { outcome: "done"; op: EffectOperationRow };

export interface ReserveInput {
  executionId: string;
  workspaceId: string;
  nodeId: string;
  businessKey: string;
  operation: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  epoch: number;
}

export type ReserveResult =
  | { outcome: "reserved"; op: EffectOperationRow }
  | { outcome: "exists"; op: EffectOperationRow }
  | { outcome: "fenced" };

/**
 * DECISION: create the logical operation, or learn it already exists.
 *
 * INSERT ... ON CONFLICT (idempotency_key) DO NOTHING: of two concurrent
 * reservations, exactly one inserts. The other blocks on the first's
 * uncommitted row and then sees the committed one — verified with two real
 * PostgreSQL sessions. That is all the UNIQUE does: one logical operation
 * per identity. It does not, and cannot, undo a request already sent.
 */
export async function reserveEffectOperation(input: ReserveInput): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    if (!(await executionOwnedBy(tx, input.executionId, input.epoch))) {
      return { outcome: "fenced" as const };
    }

    const [inserted] = await tx
      .insert(effectOperations)
      .values({
        executionId: input.executionId,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        businessKey: input.businessKey,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        deliveryPolicy: "at_most_once",
        payloadFingerprint: input.payloadFingerprint,
        status: "reserved",
        ownerEpoch: input.epoch,
      })
      .onConflictDoNothing({ target: effectOperations.idempotencyKey })
      .returning();

    if (inserted) {
      await tx.insert(effectAttempts).values({
        operationId: inserted.id,
        event: "reserved",
        actor: "worker",
        epoch: input.epoch,
        fromStatus: null,
        toStatus: "reserved",
        applied: true,
      });
      return { outcome: "reserved" as const, op: inserted };
    }

    const [existing] = await tx
      .select()
      .from(effectOperations)
      .where(eq(effectOperations.idempotencyKey, input.idempotencyKey))
      .limit(1);
    // ON CONFLICT means a committed row holds this key; not finding it is an
    // invariant violation, and throwing rolls this transaction back.
    if (!existing) throw new Error("effect operation missing after a conflicting reservation");
    return { outcome: "exists" as const, op: existing };
  });
}

/**
 * DECISION: an older epoch owns this operation and never finished; the
 * current owner of the execution takes it over.
 *
 * What that MEANS is decided here, under the row lock, from what the older
 * epoch had done:
 *   reserved  -> still reserved, now mine. Nothing was sent; safe to go on.
 *   in_flight -> UNKNOWN. The older epoch crossed the point of no return;
 *                its call may have reached the provider. Under
 *                at-most-once, nobody sends again.
 * The second line is the whole "worker died after the provider accepted"
 * case. It is also, unavoidably, the "worker died just BEFORE sending" case:
 * from the outside the two are indistinguishable, and at-most-once resolves
 * the doubt by not sending. That lost message is the price of the policy,
 * stated rather than hidden.
 */
export async function adoptEffectOperation(input: {
  operationId: string;
  executionId: string;
  epoch: number;
}): Promise<TransitionResult> {
  return db.transaction(async (tx): Promise<TransitionResult> => {
    if (!(await executionOwnedBy(tx, input.executionId, input.epoch))) return { outcome: "fenced" };

    const op = await lockOperation(tx, input.operationId);
    if (!op) return { outcome: "stale" };
    // Owning an execution says nothing about another execution's operation.
    if (op.executionId !== input.executionId) return { outcome: "fenced" };
    if (op.ownerEpoch >= input.epoch) return { outcome: "stale" }; // not older: nothing to adopt
    if (op.status !== "reserved" && op.status !== "in_flight") return { outcome: "stale" };

    const nextStatus = op.status === "in_flight" ? "unknown" : "reserved";

    const [updated] = await tx
      .update(effectOperations)
      .set({ ownerEpoch: input.epoch, status: nextStatus, updatedAt: new Date() })
      .where(
        and(
          eq(effectOperations.id, op.id),
          eq(effectOperations.executionId, input.executionId),
          lt(effectOperations.ownerEpoch, input.epoch),
          eq(effectOperations.status, op.status)
        )
      )
      .returning();
    if (!updated) return { outcome: "stale" }; // cannot happen under the row lock

    await tx.insert(effectAttempts).values({
      operationId: op.id,
      event: "adopted",
      actor: "worker",
      epoch: input.epoch,
      fromStatus: op.status,
      toStatus: nextStatus,
      applied: true,
      detail: { previousOwnerEpoch: op.ownerEpoch },
    });

    if (nextStatus === "unknown") {
      await tx.insert(effectAttempts).values({
        operationId: op.id,
        event: "unknown",
        actor: "worker",
        epoch: input.epoch,
        fromStatus: "in_flight",
        toStatus: "unknown",
        applied: true,
        detail: {
          reason: "a previous attempt crossed the point of no return and never reported an outcome",
          beganEpoch: op.beganEpoch,
        },
      });
    }

    return { outcome: "done", op: updated };
  });
}

/**
 * DECISION: cross the point of no return.
 *
 * reserved -> in_flight, recording began_epoch. The database allows this
 * exactly once per operation: began_epoch is NULL only while reserved
 * (CHECK effect_operations_began_iff_not_reserved), it is written once and
 * never changed or cleared, and nothing returns to reserved (trigger
 * effect_operations_guard). The UPDATE's WHERE requires the same state. That
 * single write is what makes "at most once" a property of the schema rather
 * than of careful code.
 *
 * What FOR SHARE on the execution buys here, precisely: this DECISION is
 * taken only by the epoch that owns the execution at that instant. It does
 * not stop the CALL from happening after ownership moves — a worker that
 * stalls between this commit and the call can still send once it wakes up.
 * That is why the next owner treats in_flight as unknown and never sends.
 *
 * It COMMITS BEFORE the network call. The opposite order — call, then
 * record — would let a crash between the two leave a sent message looking
 * "reserved", i.e. safe to send again. This order can only err the other
 * way: a crash after the commit and before the call looks ambiguous even
 * though nothing went out. False doubt is safe; false safety is a duplicate.
 */
export async function beginEffectOperation(input: {
  operationId: string;
  executionId: string;
  epoch: number;
}): Promise<TransitionResult> {
  return db.transaction(async (tx): Promise<TransitionResult> => {
    if (!(await executionOwnedBy(tx, input.executionId, input.epoch))) return { outcome: "fenced" };

    const op = await lockOperation(tx, input.operationId);
    if (!op) return { outcome: "stale" };
    if (op.executionId !== input.executionId) return { outcome: "fenced" };
    if (op.ownerEpoch !== input.epoch || op.status !== "reserved" || op.beganEpoch !== null) {
      return { outcome: "stale" };
    }

    const [updated] = await tx
      .update(effectOperations)
      .set({ status: "in_flight", beganEpoch: input.epoch, updatedAt: new Date() })
      .where(
        and(
          eq(effectOperations.id, op.id),
          eq(effectOperations.executionId, input.executionId),
          eq(effectOperations.ownerEpoch, input.epoch),
          eq(effectOperations.status, "reserved"),
          isNull(effectOperations.beganEpoch)
        )
      )
      .returning();
    if (!updated) return { outcome: "stale" }; // cannot happen under the row lock

    await tx.insert(effectAttempts).values({
      operationId: op.id,
      event: "began",
      actor: "worker",
      epoch: input.epoch,
      fromStatus: "reserved",
      toStatus: "in_flight",
      applied: true,
    });

    return { outcome: "done", op: updated };
  });
}

/**
 * FACT: what the provider said about ONE call, reported by the epoch that
 * made it.
 *
 * Fenced by AUTHORSHIP only (same execution, began_epoch = epoch) — never by
 * current ownership of the execution. The state only moves forward:
 *   in_flight | unknown -> succeeded | failed
 *   in_flight           -> unknown
 * so a late confirmation from a superseded worker turns an "unknown" into
 * the "succeeded" it really is, and nothing turns a known outcome back into
 * doubt.
 *
 * A PERSON'S resolution is not a known outcome in that sense: it is a
 * judgment ("I did not find it in the dashboard"), made while the call that
 * crossed the point of no return may still be pending — a worker that
 * stalled after `begin` can wake up and send after the operation was
 * resolved. When that call's answer arrives, the provider's answer replaces
 * the judgment (succeeded|failed resolved by a person -> the fact), and the
 * history keeps both. Without this, the record could say "failed, nothing
 * happened" about a message that was delivered, and a re-run would send it
 * again. A provider fact never replaces another provider fact.
 *
 * The fact is ALWAYS appended to the history, even when it can no longer
 * change the state (an "unknown" after the operation was settled, or a
 * report from an epoch that never made the call). `applied` says which. A
 * provider confirmation is never silently discarded.
 */
export async function recordEffectOutcome(input: {
  operationId: string;
  executionId: string;
  epoch: number;
  outcome: ProviderCallOutcome;
}): Promise<EffectOperationRow | null> {
  return db.transaction(async (tx) => {
    const op = await lockOperation(tx, input.operationId);
    if (!op) return null;

    const target: "succeeded" | "failed" | "unknown" =
      input.outcome.kind === "succeeded"
        ? "succeeded"
        : input.outcome.kind === "failed"
          ? "failed"
          : "unknown";

    // An "unknown" carries no information to replace anything with.
    const overridesResolution =
      target !== "unknown" &&
      (op.status === "succeeded" || op.status === "failed") &&
      op.resolvedByUserId !== null;
    const fromPending =
      target === "unknown" ? op.status === "in_flight" : op.status === "in_flight" || op.status === "unknown";

    const authored = op.executionId === input.executionId && op.beganEpoch === input.epoch;
    const applies = authored && (fromPending || overridesResolution);

    let current = op;
    if (applies) {
      const [updated] = await tx
        .update(effectOperations)
        .set({
          status: target,
          // Only a success carries the provider's reference. (A definitive
          // failure that replaces a person's "succeeded" must not keep the
          // reference that person pointed at.)
          providerReference: input.outcome.kind === "succeeded" ? input.outcome.providerReference : null,
          lastError:
            input.outcome.kind === "failed"
              ? { code: input.outcome.code, message: input.outcome.message }
              : input.outcome.kind === "unknown"
                ? { code: "EXTERNAL_EFFECT_UNKNOWN", message: input.outcome.reason }
                : null,
          // From here on the state is the provider's word, not a person's.
          resolvedByUserId: null,
          resolution: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(effectOperations.id, op.id),
            eq(effectOperations.executionId, input.executionId),
            eq(effectOperations.beganEpoch, input.epoch),
            target === "unknown"
              ? eq(effectOperations.status, "in_flight")
              : or(
                  inArray(effectOperations.status, ["in_flight", "unknown"]),
                  and(
                    inArray(effectOperations.status, ["succeeded", "failed"]),
                    isNotNull(effectOperations.resolvedByUserId)
                  )
                )
          )
        )
        .returning();
      // Under the row lock this cannot be empty; if it were, throwing rolls
      // back and the caller's retry re-reads the row.
      if (!updated) throw new Error("effect operation vanished while locked");
      current = updated;
    }

    await tx.insert(effectAttempts).values({
      operationId: op.id,
      event: target,
      actor: "worker",
      epoch: input.epoch,
      fromStatus: op.status,
      toStatus: current.status,
      applied: applies,
      providerReference:
        input.outcome.kind === "succeeded" ? input.outcome.providerReference : null,
      detail: {
        ...(input.outcome.kind === "failed"
          ? { code: input.outcome.code, message: input.outcome.message }
          : input.outcome.kind === "unknown"
            ? { reason: input.outcome.reason }
            : {}),
        ...(authored ? {} : { notApplied: "reported by an epoch that did not make the call" }),
        ...(authored && !applies ? { notApplied: `operation was already ${op.status}` } : {}),
        // Which judgment the provider's word replaced — the 'resolved' fact
        // before it has the evidence; this names it at the point of override.
        ...(applies && overridesResolution
          ? {
              overridesResolution: {
                status: op.status,
                resolution: op.resolution,
                resolvedByUserId: op.resolvedByUserId,
              },
            }
          : {}),
      },
    });

    return current;
  });
}

// ---- MODELO 1 (live user) --------------------------------------------------
//
// Fase 10.5A. What a person may do with an operation is defined — and argued
// — in resolution.ts. This section only carries it out.

/** When the call crossed the point of no return, per operation: the first
 *  'began' fact in its history. Decoded with the column's own mapper —
 *  drizzle's postgres.js driver leaves raw timestamps as strings. */
const beganAtSql = sql<Date | null>`(
  select min(${effectAttempts.createdAt}) from ${effectAttempts}
  where ${effectAttempts.operationId} = ${effectOperations.id}
    and ${effectAttempts.event} = 'began'
)`.mapWith(effectAttempts.createdAt);

export type ResolveEffectResult =
  | { outcome: "resolved"; operation: EffectOperationRow }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "not_unknown"; status: string }
  | { outcome: "execution_active"; executionStatus: string }
  | { outcome: "too_early"; resolvableFrom: Date };

/**
 * Explicit resolution of an ambiguous operation — the ONLY way a person
 * moves it out of "unknown". Nothing in the worker path ever turns unknown
 * into failed or into a retry by itself.
 *
 * Refused, each with its own answer, when:
 *   forbidden          the member is not owner/admin (reading stays open);
 *   not_unknown        the outcome is already known — from the provider, or
 *                      from a person (nobody overwrites anybody);
 *   execution_active   the execution has not ended: something may still be
 *                      acting on its behalf;
 *   too_early          the cooling period since the call began has not
 *                      passed — the call itself may still answer.
 * All of it is checked in ONE transaction, with the operation locked, on
 * the database's clock (never the app server's).
 *
 * What is written: the operation's new state (succeeded for confirmed_sent,
 * failed otherwise), who decided and what (resolved_by_user_id,
 * resolution), and ONE append-only `resolved` fact carrying the decision,
 * the evidence and the justification. The migration 0007 refuses that fact
 * without them, whatever path wrote it.
 *
 * A resolution is a JUDGMENT. If the call's own answer arrives afterwards,
 * recordEffectOutcome replaces the judgment with it and keeps both in the
 * history.
 */
export async function resolveUnknownEffectOperation(
  userId: string,
  workspaceId: string,
  operationId: string,
  input: ResolveEffectInput,
  options: { coolingPeriodSeconds?: number } = {}
): Promise<ResolveEffectResult> {
  const membership = await requireWorkspaceMembership(userId, workspaceId);
  if (!(RESOLVER_ROLES as readonly string[]).includes(membership.role)) {
    return { outcome: "forbidden" };
  }
  const cooling = options.coolingPeriodSeconds ?? RESOLUTION_COOLING_PERIOD_SECONDS;

  return db.transaction(async (tx): Promise<ResolveEffectResult> => {
    const [op] = await tx
      .select()
      .from(effectOperations)
      .where(and(eq(effectOperations.id, operationId), eq(effectOperations.workspaceId, workspaceId)))
      .limit(1)
      .for("update");
    if (!op) return { outcome: "not_found" };
    if (op.status !== "unknown") return { outcome: "not_unknown", status: op.status };

    // A terminal status never changes again, so reading it without a lock
    // is enough: if it is terminal now, it stays terminal.
    const [execution] = await tx
      .select({ status: executions.status })
      .from(executions)
      .where(eq(executions.id, op.executionId))
      .limit(1);
    if (!execution || !(TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(execution.status)) {
      return { outcome: "execution_active", executionStatus: execution?.status ?? "missing" };
    }

    // On the database clock. The operation's own creation time stands in
    // only if the 'began' fact is missing (history purged) — unknown always
    // has one otherwise.
    const createdAtIso = op.createdAt.toISOString();
    const [timing] = await tx
      .select({
        resolvableFrom: sql<string>`(coalesce(min(${effectAttempts.createdAt}), ${createdAtIso}::timestamptz) + ${cooling}::int * interval '1 second')::text`,
        ready: sql<boolean>`coalesce(min(${effectAttempts.createdAt}), ${createdAtIso}::timestamptz) + ${cooling}::int * interval '1 second' <= now()`,
      })
      .from(effectAttempts)
      .where(and(eq(effectAttempts.operationId, op.id), eq(effectAttempts.event, "began")));
    if (!timing || !timing.ready) {
      return {
        outcome: "too_early",
        resolvableFrom: timing ? new Date(timing.resolvableFrom) : new Date(Date.now() + cooling * 1000),
      };
    }

    const status = statusForResolution(input.resolution);
    const [updated] = await tx
      .update(effectOperations)
      .set({
        status,
        providerReference: input.resolution === "confirmed_sent" ? (input.providerReference ?? null) : null,
        lastError:
          status === "failed"
            ? {
                code: input.resolution === "confirmed_not_sent" ? "RESOLVED_NOT_SENT" : "RESOLVED_REJECTED",
                message: input.justification,
              }
            : null,
        resolvedByUserId: userId,
        resolution: input.resolution,
        updatedAt: new Date(),
      })
      .where(and(eq(effectOperations.id, op.id), eq(effectOperations.status, "unknown")))
      .returning();
    if (!updated) return { outcome: "not_unknown", status: op.status }; // cannot happen under the lock

    await tx.insert(effectAttempts).values({
      operationId: op.id,
      event: "resolved",
      actor: "user",
      epoch: null,
      actorUserId: userId,
      fromStatus: "unknown",
      toStatus: status,
      applied: true,
      // confirmed_sent: the effect's reference; confirmed_rejected: the
      // provider's id for the rejection, if the person has one.
      providerReference: input.providerReference ?? null,
      detail: {
        resolution: input.resolution,
        evidence: {
          source: input.evidence.source,
          ...(input.evidence.detail ? { detail: input.evidence.detail } : {}),
        },
        justification: input.justification,
      },
    });

    return { outcome: "resolved", operation: updated };
  });
}

/**
 * Operations of the caller's workspace, newest first — by default the ones
 * waiting for a person ("unknown"). Joined with their execution and
 * workflow, because "which workflow, which run" is the first thing anyone
 * resolving one needs. The shape a client sees is decided by
 * effect-view.ts, not here.
 */
export async function listEffectOperations(
  userId: string,
  workspaceId: string,
  filter: { status?: EffectStatus; limit?: number } = {}
) {
  await requireWorkspaceMembership(userId, workspaceId);
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);

  return db
    .select({
      op: effectOperations,
      executionStatus: executions.status,
      workflowId: executions.workflowId,
      workflowName: workflows.name,
      beganAt: beganAtSql,
    })
    .from(effectOperations)
    .innerJoin(executions, eq(executions.id, effectOperations.executionId))
    .innerJoin(workflows, eq(workflows.id, executions.workflowId))
    .where(
      and(
        eq(effectOperations.workspaceId, workspaceId),
        filter.status ? eq(effectOperations.status, filter.status) : undefined
      )
    )
    .orderBy(desc(effectOperations.updatedAt))
    .limit(limit);
}

/** One operation of the caller's workspace, with its whole history in the
 *  order it happened (`seq`, not created_at: facts of one transaction share
 *  now()). Null when it is not in this workspace. */
export async function getEffectOperationDetail(userId: string, workspaceId: string, operationId: string) {
  await requireWorkspaceMembership(userId, workspaceId);

  const [row] = await db
    .select({
      op: effectOperations,
      executionStatus: executions.status,
      workflowId: executions.workflowId,
      workflowName: workflows.name,
      beganAt: beganAtSql,
    })
    .from(effectOperations)
    .innerJoin(executions, eq(executions.id, effectOperations.executionId))
    .innerJoin(workflows, eq(workflows.id, executions.workflowId))
    .where(and(eq(effectOperations.id, operationId), eq(effectOperations.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;

  const attempts = await db
    .select()
    .from(effectAttempts)
    .where(eq(effectAttempts.operationId, operationId))
    .orderBy(effectAttempts.seq);

  return { ...row, attempts };
}

/**
 * Observability for one execution: which logical operations it attempted,
 * which epochs touched each, the last known state, whether the outcome is
 * known or ambiguous, and which idempotency key was used. An explicit
 * allowlist — no payload exists to leak (only its hash is stored), and no
 * column is exposed by spreading a row.
 */
export async function listEffectOperationsForExecution(
  userId: string,
  workspaceId: string,
  executionId: string
) {
  await requireWorkspaceMembership(userId, workspaceId);

  const ops = await db
    .select()
    .from(effectOperations)
    .where(
      and(eq(effectOperations.executionId, executionId), eq(effectOperations.workspaceId, workspaceId))
    );
  if (ops.length === 0) return [];

  const attempts = await db
    .select()
    .from(effectAttempts)
    .where(inArray(effectAttempts.operationId, ops.map((o) => o.id)))
    // seq, not createdAt: events written in one transaction share now().
    .orderBy(effectAttempts.seq);

  return ops.map((op) => ({
    operationId: op.id,
    nodeId: op.nodeId,
    businessKey: op.businessKey,
    operation: op.operation,
    idempotencyKey: op.idempotencyKey,
    deliveryPolicy: op.deliveryPolicy,
    status: op.status,
    outcomeKnown: op.status === "succeeded" || op.status === "failed",
    ownerEpoch: op.ownerEpoch,
    beganEpoch: op.beganEpoch,
    providerReference: op.providerReference,
    lastError: op.lastError,
    resolvedByUserId: op.resolvedByUserId,
    resolution: op.resolution,
    attempts: attempts
      .filter((a) => a.operationId === op.id)
      .map((a) => ({
        event: a.event,
        actor: a.actor,
        epoch: a.epoch,
        fromStatus: a.fromStatus,
        toStatus: a.toStatus,
        applied: a.applied,
        providerReference: a.providerReference,
        detail: a.detail,
        at: a.createdAt.toISOString(),
      })),
  }));
}
