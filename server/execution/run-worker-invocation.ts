import { claimNextQueuedExecution } from "./execution-queue";
import { processClaimedExecution } from "./process-queued-execution";
import { EXECUTION_LIMITS } from "@/lib/execution/types";

/**
 * ONE worker invocation — bounded, and deliberately not a loop that lives
 * forever.
 *
 * The consumer of this queue is a serverless function woken by a scheduler
 * (Supabase Cron), not a long-lived process. So the unit of work is "drain
 * for a while, then stop and return", and every exit path is one this
 * function chose: it never relies on the platform killing it. There is no
 * in-memory queue and no in-memory lock anywhere here — every job comes
 * from PostgreSQL and the only mutual exclusion is the one the database
 * already provides.
 *
 * THREE WAYS IT STOPS, all voluntary:
 *
 *   "empty_queue"  claimNextQueuedExecution() found nothing. The common
 *                  case: the invocation returns in milliseconds, which is
 *                  what makes a frequent schedule cheap.
 *   "max_jobs"     it processed its per-invocation cap. Bounds how much a
 *                  single invocation can hold, so one busy tick can't
 *                  starve the next.
 *   "deadline"     not enough budget left to safely START another job.
 *
 * WHY THE DEADLINE RESERVES A FULL ENGINE TIMEOUT
 * A job may legitimately take EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS, so a
 * new one is only started when at least that much budget remains. Getting
 * this wrong is not a correctness bug — an execution cut off mid-run is
 * exactly the "worker died" case the reaper reclaims and the fencing
 * protects — but it is a real cost: every cut-off run burns one of the
 * execution's MAX_CLAIM_ATTEMPTS. Three truncated invocations in a row
 * would abandon a perfectly healthy workflow as WORKER_CRASHED. The
 * reserve exists to keep that from being routine.
 *
 * WHAT THIS IS NOT
 * The budget is not a heartbeat and must not be read as one. It bounds how
 * long this invocation chooses to work; it says nothing about whether the
 * process is alive, and nothing about it reaches the database. A function
 * frozen between two statements looks identical to a healthy one from the
 * outside — that is precisely the gap a real heartbeat/lease would close,
 * and it is not closed here. Correctness under that gap still rests
 * entirely on the fencing epoch (see finishQueuedExecution) and on reclaim,
 * not on any timing assumption made in this file.
 */

export const WORKER_DEFAULTS = {
  MAX_JOBS_PER_INVOCATION: 10,
  /** Well under the route's own maxDuration — see the route for the pairing. */
  BUDGET_MS: 240_000,
  /** Budget that must remain before starting another job. */
  RESERVE_MS: EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS,
} as const;

/** Ceilings for caller-supplied overrides, so a bad request can't ask for
 *  an invocation longer than the platform would allow anyway. */
export const WORKER_CEILINGS = {
  MAX_JOBS: 50,
  MAX_BUDGET_MS: 280_000,
  MIN_BUDGET_MS: 1_000,
} as const;

export type WorkerStopReason = "empty_queue" | "max_jobs" | "deadline";

export interface WorkerInvocationOptions {
  maxJobs?: number;
  budgetMs?: number;
  /** Injectable clock. Tests drive the deadline with it; production doesn't
   *  pass it and gets Date.now. */
  now?: () => number;
}

export interface WorkerJobOutcome {
  executionId: string;
  /** "crashed" = processClaimedExecution itself threw (a database failure,
   *  say), so this invocation wrote nothing for that execution and left the
   *  row for the reaper. Distinct from "error", which is a workflow that
   *  ran and failed — a normal, fully-persisted outcome. */
  status: "success" | "error" | "cancelled" | "skipped" | "crashed";
  reason?: string;
}

export interface WorkerInvocationSummary {
  claimed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  skipped: number;
  crashed: number;
  stoppedBy: WorkerStopReason;
  durationMs: number;
  jobs: WorkerJobOutcome[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export async function runWorkerInvocation(
  options: WorkerInvocationOptions = {}
): Promise<WorkerInvocationSummary> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const maxJobs = clamp(
    options.maxJobs ?? WORKER_DEFAULTS.MAX_JOBS_PER_INVOCATION,
    1,
    WORKER_CEILINGS.MAX_JOBS
  );
  const budgetMs = clamp(
    options.budgetMs ?? WORKER_DEFAULTS.BUDGET_MS,
    WORKER_CEILINGS.MIN_BUDGET_MS,
    WORKER_CEILINGS.MAX_BUDGET_MS
  );

  const jobs: WorkerJobOutcome[] = [];
  let stoppedBy: WorkerStopReason = "empty_queue";

  for (;;) {
    if (jobs.length >= maxJobs) {
      stoppedBy = "max_jobs";
      break;
    }

    // Checked BEFORE claiming, never after: claiming a job this invocation
    // has no time to run would burn one of its attempts for nothing.
    if (now() - startedAt + WORKER_DEFAULTS.RESERVE_MS > budgetMs) {
      stoppedBy = "deadline";
      break;
    }

    // Discovery and claim in one transaction, under FOR UPDATE SKIP LOCKED
    // — this is what lets several invocations run at once without ever
    // handing two of them the same row, with no coordination between them.
    const claimed = await claimNextQueuedExecution();
    if (!claimed) {
      stoppedBy = "empty_queue";
      break;
    }

    try {
      // The row is already claimed, so the processor must NOT claim again —
      // see processClaimedExecution's own comment.
      const outcome = await processClaimedExecution(claimed);
      jobs.push(
        outcome.status === "skipped"
          ? { executionId: outcome.executionId, status: "skipped", reason: outcome.reason }
          : { executionId: outcome.executionId, status: outcome.status }
      );
    } catch (err) {
      // One job blowing up must not take the invocation down with it: the
      // remaining queue is still drainable, and this execution is left
      // "running" for the reaper to reclaim — which is exactly the state
      // recovery was built for.
      jobs.push({
        executionId: claimed.id,
        status: "crashed",
        reason: err instanceof Error ? err.message : "unknown processor failure",
      });
    }
  }

  return {
    claimed: jobs.length,
    succeeded: jobs.filter((j) => j.status === "success").length,
    failed: jobs.filter((j) => j.status === "error").length,
    cancelled: jobs.filter((j) => j.status === "cancelled").length,
    skipped: jobs.filter((j) => j.status === "skipped").length,
    crashed: jobs.filter((j) => j.status === "crashed").length,
    stoppedBy,
    durationMs: now() - startedAt,
    jobs,
  };
}
