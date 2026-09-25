import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeSchedulerRequest } from "@/lib/auth/scheduler";
import { runWorkerInvocation, WORKER_CEILINGS } from "@/server/execution/run-worker-invocation";
import { apiError } from "@/lib/api-error";

/**
 * The queue CONSUMER, as one bounded invocation.
 *
 * Called by Supabase Cron over HTTP (see db/supabase/cron-jobs.sql), not by
 * Vercel Cron: on the Hobby plan Vercel Cron runs once per day, which is
 * unusable as a queue consumer, and Supabase Cron is already part of this
 * project's infrastructure and schedules down to the second.
 *
 * It drains jobs and returns. It does not loop forever, does not hold state
 * between invocations, and does not keep a queue in memory — every job
 * comes from PostgreSQL. Several invocations may overlap; that is safe by
 * construction, not by coordination, because claimNextQueuedExecution()
 * claims under FOR UPDATE SKIP LOCKED and every write is fenced by the
 * claim epoch.
 *
 * Nothing about the job travels over this request: the scheduler posts an
 * empty body. No workflow, no document, no workspaceId, no userId, no
 * credentials. The executions table is the queue and the persisted snapshot
 * is the source of truth.
 */

export const runtime = "nodejs"; // postgres.js needs Node, not Edge.
export const dynamic = "force-dynamic"; // never cached, never prerendered.

/**
 * 300s is the documented default maximum on every Vercel plan with Fluid
 * compute. The worker's own budget (WORKER_DEFAULTS.BUDGET_MS, 240s) sits
 * below it on purpose: the invocation should always end because IT decided
 * to, not because the platform killed it mid-job.
 */
export const maxDuration = 300;

const workerRequestSchema = z.object({
  maxJobs: z.number().int().positive().max(WORKER_CEILINGS.MAX_JOBS).optional(),
  budgetMs: z.number().int().positive().max(WORKER_CEILINGS.MAX_BUDGET_MS).optional(),
});

export async function POST(request: NextRequest) {
  const auth = authorizeSchedulerRequest(request);
  if (!auth.ok) {
    if (auth.reason === "not_configured") {
      // Not an auth failure: nothing can authenticate, because the
      // deployment has no CRON_SECRET. Said plainly so a misconfigured
      // environment is debuggable instead of looking like a wrong secret.
      return apiError(
        "SCHEDULER_NOT_CONFIGURED",
        "This endpoint is disabled because CRON_SECRET is not set.",
        503
      );
    }
    return apiError("UNAUTHENTICATED", "Not authenticated", 401);
  }

  let body: unknown = {};
  const raw = await request.text();
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    }
  }

  const parsed = workerRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Invalid worker invocation request", 400);
  }

  const summary = await runWorkerInvocation(parsed.data);

  // 200 regardless of how individual jobs ended: a workflow that failed is
  // a successfully processed job. Only the invocation itself failing would
  // be a non-2xx, and that surfaces as a thrown error, not as this body.
  return NextResponse.json(summary, { status: 200 });
}
