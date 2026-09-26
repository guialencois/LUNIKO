import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { getExecutionById } from "@/server/execution/execution-repository";
import { toExecutionDetailView } from "@/server/execution/execution-view";
import { apiError } from "@/lib/api-error";

interface RouteParams {
  params: { executionId: string };
}

/**
 * Reads one execution. This is the half of the asynchronous contract that
 * makes mode:"async" usable at all — the POST hands back an executionId
 * and nothing else, so without this there is no way for anyone to learn
 * what happened.
 *
 *   queued | running   status and whatever timestamps exist yet
 *   success            status, finishedAt, durationMs, result
 *   error | cancelled  status, finishedAt, durationMs, error
 *
 * AUTHORIZATION follows the same rule as the execute route, for the same
 * reason: the workspace is derived server-side from the authenticated user
 * and is never read from the request. There is no query parameter, header
 * or body field that can influence which workspace this reads from — the
 * only thing the caller supplies is the execution id, and
 * getExecutionById's own WHERE clause filters by the server-resolved
 * workspace. An execution belonging to someone else is therefore
 * indistinguishable from one that does not exist: both are 404. Saying
 * "forbidden" instead would confirm the id is real.
 *
 * WHAT COMES BACK is built by toExecutionDetailView, an explicit allowlist
 * — never a spread of the row. It leaves out `runner` and `claimAttempts`
 * (internal lifecycle and the fencing epoch), the workflow document, and
 * per-node payloads. See that module for the reasoning on each.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  let found;
  try {
    found = await getExecutionById(user.id, workspaceId, params.executionId);
  } catch {
    // requireWorkspaceMembership throws when the user isn't a member. That
    // is the same answer as "no such execution" from the caller's side, and
    // it must not be distinguishable.
    return apiError("EXECUTION_NOT_FOUND", "This execution could not be found", 404);
  }

  if (!found) {
    return apiError("EXECUTION_NOT_FOUND", "This execution could not be found", 404);
  }

  return NextResponse.json(toExecutionDetailView(found.execution, found.nodes), { status: 200 });
}
