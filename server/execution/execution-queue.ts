import { db } from "@/lib/db";
import { executions } from "@/lib/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { LEASE_DURATION_MS } from "./execution-repository";
import type { ExecutionRow } from "@/lib/db/schema";

/**
 * The Postgres-based queue decided in docs/async-execution.md ("Fila —
 * decisão conceitual"): there is no separate queue store. The `executions`
 * table already IS the queue — a row with status "queued" is a job waiting
 * to be picked up. This file adds exactly the two operations that idea was
 * still missing after 4C: a guarded "enqueue" (validate before treating a
 * row as queueable) and "claim whatever's next" (a worker with no prior
 * context needs a way to discover a job, not just claim one it was already
 * told about — lib/execution/planner.ts/executor.ts are untouched by this).
 *
 * MODELO 2 throughout (docs/async-execution.md, "Autorização — DECIDIDO"):
 * every function here takes only an `executionId` (or nothing at all),
 * never userId/workspaceId. Authorization already happened once, when the
 * row was created via createQueuedExecution (MODELO 1, 4C) — this file
 * never re-checks membership, and never accepts a workspaceId from a
 * caller as authority for anything.
 */

export interface ExecutionJob {
  executionId: string;
}

export class QueueError extends Error {
  code: "EXECUTION_NOT_FOUND" | "EXECUTION_NOT_QUEUEABLE";
  constructor(code: "EXECUTION_NOT_FOUND" | "EXECUTION_NOT_QUEUEABLE", message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

/**
 * Internal, no-auth read — deliberately not exported. This exists only so
 * enqueueExecution can check a row's current state without going through
 * MODELO 1's getExecutionById (which requires a live user session this
 * function was never given, by design — see the file header). Never used
 * to serve a result to an end user; only to validate state internally.
 */
async function readExecutionForQueue(executionId: string) {
  const [row] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  return row ?? null;
}

/**
 * Validates that `executionId` refers to a real, currently-"queued"
 * execution, and returns the minimal job descriptor for it — {executionId}
 * and nothing else. This never inserts or mutates anything: the row is
 * already in "queued", either because createQueuedExecution (4C) put it
 * there or because the reaper returned it there after a stale claim (4G,
 * reclaimExpiredExecution). "Enqueueing" here means confirming that's still
 * true, not creating new state. That's
 * exactly what makes calling this twice on the same, still-queued id safe
 * (item 5 — no second row, no side effect beyond the validation itself).
 * Once the row moves past "queued" (claimed, or otherwise), a later call
 * with the same id correctly stops succeeding — that's not a duplication
 * bug, it's the guard doing its job (item 4).
 *
 * Throws QueueError, never returns a "soft" failure shape — the future
 * caller (the API route that doesn't exist yet, per this task's scope) is
 * expected to translate this into its own structured error response, the
 * same way it already does for ExecutionEngineError today.
 */
export async function enqueueExecution(executionId: string): Promise<ExecutionJob> {
  const execution = await readExecutionForQueue(executionId);

  if (!execution) {
    throw new QueueError("EXECUTION_NOT_FOUND", `No execution found with id "${executionId}"`);
  }
  if (execution.status !== "queued") {
    throw new QueueError(
      "EXECUTION_NOT_QUEUEABLE",
      `Execution "${executionId}" is not queueable — current status is "${execution.status}"`
    );
  }

  return { executionId };
}

/**
 * Finds and atomically claims the oldest still-queued execution, if any.
 * This is the "SELECT then UPDATE" pattern the task explicitly warned
 * against doing unsafely — the difference here is both statements run
 * inside one transaction, and the SELECT uses `FOR UPDATE SKIP LOCKED`:
 * concurrent callers each lock a *different* candidate row (or find none
 * left) instead of blocking on or double-claiming the same one. This is
 * the standard, safe idiom for "use a SQL table as a job queue" — not a
 * race condition, despite having two statements.
 *
 * Deliberately does NOT delegate the update half to claimQueuedExecution
 * (4C): that function opens its own top-level statement against `db`, not
 * this transaction's connection — calling it from inside here would either
 * block waiting on the very row lock this transaction is already holding
 * (self-deadlock) or, worse, silently run outside the lock's protection.
 * The SET clause is intentionally identical to claimQueuedExecution's for
 * consistency, but it has to be inlined here to stay on the same
 * transaction/connection as the SELECT ... FOR UPDATE SKIP LOCKED above it.
 *
 * claimQueuedExecution (4C) is still the right tool for "claim this one
 * specific id I already know about" — both coexist for different
 * consumption patterns a future worker may use.
 */
export async function claimNextQueuedExecution(): Promise<ExecutionRow | null> {
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.runner, "worker"), eq(executions.status, "queued")))
      .orderBy(asc(executions.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!next) return null;

    const [claimed] = await tx
      .update(executions)
      .set({
        status: "running",
        startedAt: new Date(),
        claimAttempts: sql`${executions.claimAttempts} + 1`,
        // Fase 9: o lease nasce com a posse, igual a claimQueuedExecution.
        // Inline aqui pelo mesmo motivo que o resto do SET é — esta
        // transação segura o row lock do SELECT ... FOR UPDATE SKIP LOCKED
        // acima, e delegar sairia dela.
        leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
      })
      .where(
        and(
          eq(executions.id, next.id),
          eq(executions.runner, "worker"),
          eq(executions.status, "queued")
        )
      )
      .returning();

    return claimed ?? null;
  });
}
