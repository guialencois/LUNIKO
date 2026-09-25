import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import {
  getEffectOperationDetail,
  resolveUnknownEffectOperation,
} from "@/server/execution/effects/effect-repository";
import {
  ResolveRequestValidationError,
  validateResolveEffectRequest,
} from "@/server/execution/effects/resolution";
import { toEffectOperationView } from "@/server/execution/effects/effect-view";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: { operationId: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A legitimate resolution is well under 8 KB (1000 + 500 + 256 characters
 *  of text). Anything far above it is refused before it is even parsed. */
const MAX_BODY_LENGTH = 16_384;

/**
 * Fase 10.5A — a person settles an "unknown" operation, with evidence.
 * What may and may not be done is defined in
 * server/execution/effects/resolution.ts; this only translates it to HTTP.
 *
 * Body:
 *   {
 *     "resolution": "confirmed_sent" | "confirmed_not_sent" | "confirmed_rejected",
 *     "providerReference": "...",   // required for confirmed_sent
 *     "evidence": { "source": "provider_api" | "provider_dashboard"
 *                             | "provider_webhook" | "provider_support",
 *                   "detail": "what was checked and what it showed" },
 *     "justification": "why this conclusion (10-1000 chars)"
 *   }
 *
 *   200 { operation }                  resolved
 *   400 VALIDATION_ERROR               missing evidence/justification/reference
 *   413 PAYLOAD_TOO_LARGE              body far larger than any resolution
 *   403 EFFECT_RESOLUTION_FORBIDDEN    only owner/admin decide
 *   404 EFFECT_NOT_FOUND
 *   409 EFFECT_NOT_UNKNOWN             the outcome is already known
 *   409 EFFECT_EXECUTION_ACTIVE        its execution has not ended
 *   409 EFFECT_RESOLUTION_TOO_EARLY    the call may still answer by itself
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await getCurrentUser();
  if (!user) return apiError("UNAUTHENTICATED", "Not authenticated", 401);

  if (!UUID.test(params.operationId)) {
    return apiError("EFFECT_NOT_FOUND", "This operation could not be found", 404);
  }

  const workspaceId = await ensureDefaultWorkspace(user.id, user.email ?? "usuário");

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  if (raw.length > MAX_BODY_LENGTH) {
    return apiError("PAYLOAD_TOO_LARGE", "Request body is too large for a resolution", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  let input;
  try {
    input = validateResolveEffectRequest(body);
  } catch (err) {
    if (err instanceof ResolveRequestValidationError) {
      return apiError("VALIDATION_ERROR", describeIssues(err.issues), 400);
    }
    throw err;
  }

  let result;
  try {
    result = await resolveUnknownEffectOperation(user.id, workspaceId, params.operationId, input);
  } catch {
    return apiError("EFFECT_RESOLUTION_FAILED", "Unable to resolve this operation. Please try again.", 500);
  }

  switch (result.outcome) {
    case "resolved": {
      const detail = await getEffectOperationDetail(user.id, workspaceId, params.operationId);
      return NextResponse.json({ operation: detail ? toEffectOperationView(detail) : null });
    }
    case "not_found":
      return apiError("EFFECT_NOT_FOUND", "This operation could not be found", 404);
    case "forbidden":
      return apiError(
        "EFFECT_RESOLUTION_FORBIDDEN",
        "Only a workspace owner or admin can resolve an external operation.",
        403
      );
    case "not_unknown":
      return apiError(
        "EFFECT_NOT_UNKNOWN",
        `This operation is already ${result.status}; only an operation whose outcome is unknown can be resolved.`,
        409
      );
    case "execution_active":
      return apiError(
        "EFFECT_EXECUTION_ACTIVE",
        `Its execution is still ${result.executionStatus}; resolve it after the execution has ended.`,
        409
      );
    case "too_early":
      return apiError(
        "EFFECT_RESOLUTION_TOO_EARLY",
        `The call that crossed the point of no return may still answer on its own. It can be resolved from ${result.resolvableFrom.toISOString()}.`,
        409
      );
  }
}

/** First issue of a zod flatten(), as "path: message" — enough for a form. */
function describeIssues(issues: unknown): string {
  const flat = issues as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
  const field = Object.entries(flat.fieldErrors ?? {}).find(([, msgs]) => msgs && msgs.length > 0);
  if (field) return `${field[0]}: ${field[1]![0]}`;
  if (flat.formErrors && flat.formErrors.length > 0) return flat.formErrors[0]!;
  return "Invalid resolution request";
}
