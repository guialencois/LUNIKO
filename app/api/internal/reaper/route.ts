import { NextRequest, NextResponse } from "next/server";
import { authorizeSchedulerRequest } from "@/lib/auth/scheduler";
import { recoverStaleExecutions } from "@/server/execution/recovery-reaper";
import { apiError } from "@/lib/api-error";

/**
 * The recovery sweep, triggered by Supabase Cron (db/supabase/cron-jobs.sql).
 *
 * It calls recoverStaleExecutions() and nothing else. No engine, no
 * executor, no workflow, no external effect, and no second copy of the
 * recovery rules: the decision of what is stale, what may be returned to
 * the queue and what must be abandoned lives entirely in the repository's
 * WHERE clauses, evaluated atomically by PostgreSQL.
 *
 * THE OVERRIDES THIS ROUTE DELIBERATELY DOES NOT ACCEPT
 * recoverStaleExecutions() takes optional staleMs/maxAttempts, and this
 * route ignores them by design — they are not readable from the request at
 * all. A caller who could pass `staleMs: 0` would turn the reaper into a
 * weapon: every running execution instantly looks stale, so healthy jobs
 * get pulled back into the queue, and once their attempts run out they are
 * abandoned as WORKER_CRASHED. Those parameters exist so tests can compress
 * time; they have no business crossing a network boundary, authenticated
 * or not.
 *
 * SCHEDULING
 * REAPER_STALE_MS is 90s (MAX_EXECUTION_TIME_MS + 60s of margin), so the
 * cron interval decides detection latency, not correctness: a dead worker's
 * execution is recovered between 90s and 90s + one interval after it
 * stalled. Running it more often than that only shortens the tail; running
 * it far less often leaves jobs stuck for longer. Sweeps are idempotent and
 * safe to overlap — two concurrent sweeps cannot double-recover a row.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = authorizeSchedulerRequest(request);
  if (!auth.ok) {
    if (auth.reason === "not_configured") {
      return apiError(
        "SCHEDULER_NOT_CONFIGURED",
        "This endpoint is disabled because CRON_SECRET is not set.",
        503
      );
    }
    return apiError("UNAUTHENTICATED", "Not authenticated", 401);
  }

  const summary = await recoverStaleExecutions();

  return NextResponse.json(summary, { status: 200 });
}
