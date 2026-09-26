import { RESOLUTION_COOLING_PERIOD_SECONDS } from "./resolution";

/**
 * The public shape of an external operation, for /api/effects (Fase 10.5A).
 *
 * AN ALLOWLIST, like execution-view.ts: every field is named on purpose and
 * no row is ever spread, so a column added later cannot start leaking by
 * itself. There is no payload to leak (only its hash is stored, and the
 * hash is not shown either — it is for comparison, not for people).
 *
 * WHAT IS SHOWN, AND WHY
 *   businessKey        which entity the operation affected — the operator
 *                      needs it to look the effect up at the provider. It
 *                      may be personal data (prefer internal ids, see
 *                      docs/async-execution.md), which is why this view is
 *                      for workspace members only.
 *   idempotency key    NOT shown: an internal identity, useful to nobody
 *                      reading this, and the one value a caller could
 *                      replay against a provider that honours it.
 *   attempt (epoch)    shown in the history: "attempt 1 made the call,
 *                      attempt 2 found it in flight" is exactly what an
 *                      operator needs to understand an unknown.
 */

export interface EffectOperationSource {
  op: {
    id: string;
    executionId: string;
    nodeId: string;
    businessKey: string;
    operation: string;
    status: string;
    providerReference: string | null;
    lastError: unknown;
    resolution: string | null;
    resolvedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  executionStatus: string;
  workflowId: string;
  workflowName: string;
  /** Date, or the raw timestamp string a driver may hand back. */
  beganAt: Date | string | null;
}

export interface EffectAttemptSource {
  seq: number;
  event: string;
  actor: string;
  epoch: number | null;
  actorUserId: string | null;
  fromStatus: string | null;
  toStatus: string;
  applied: boolean;
  providerReference: string | null;
  detail: unknown;
  createdAt: Date;
}

export interface EffectOperationView {
  operationId: string;
  executionId: string;
  executionStatus: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  operation: string;
  businessKey: string;
  status: string;
  /** succeeded/failed — the outcome is known (from the provider or a person). */
  outcomeKnown: boolean;
  resolution: string | null;
  resolvedByUserId: string | null;
  providerReference: string | null;
  lastError: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  /** When the call crossed the point of no return. */
  beganAt: string | null;
  /** Only for "unknown": the earliest moment a person may resolve it (the
   *  execution must also have ended — see executionStatus). */
  resolvableFrom: string | null;
}

export interface EffectAttemptView {
  seq: number;
  event: string;
  actor: string;
  attempt: number | null;
  actorUserId: string | null;
  fromStatus: string | null;
  toStatus: string;
  applied: boolean;
  providerReference: string | null;
  at: string;
  detail: Record<string, unknown>;
}

function errorOf(raw: unknown): { code: string; message: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as { code?: unknown; message?: unknown };
  return typeof e.code === "string" && typeof e.message === "string" ? { code: e.code, message: e.message } : null;
}

export function toEffectOperationView(source: EffectOperationSource): EffectOperationView {
  const { op } = source;
  const began = source.beganAt === null ? null : new Date(source.beganAt);
  const beganAt = began && !Number.isNaN(began.getTime()) ? began : null;
  return {
    operationId: op.id,
    executionId: op.executionId,
    executionStatus: source.executionStatus,
    workflowId: source.workflowId,
    workflowName: source.workflowName,
    nodeId: op.nodeId,
    operation: op.operation,
    businessKey: op.businessKey,
    status: op.status,
    outcomeKnown: op.status === "succeeded" || op.status === "failed",
    resolution: op.resolution,
    resolvedByUserId: op.resolvedByUserId,
    providerReference: op.providerReference,
    lastError: errorOf(op.lastError),
    createdAt: op.createdAt.toISOString(),
    updatedAt: op.updatedAt.toISOString(),
    beganAt: beganAt ? beganAt.toISOString() : null,
    // Same clock origin as the repository's check: the call's 'began' fact,
    // or the operation's creation if that fact is gone (purged history).
    resolvableFrom:
      op.status === "unknown"
        ? new Date((beganAt ?? op.createdAt).getTime() + RESOLUTION_COOLING_PERIOD_SECONDS * 1000).toISOString()
        : null,
  };
}

/** Keys the history's `detail` may carry — all written by this codebase.
 *  Picked one by one; anything else stays in the database. */
const DETAIL_KEYS = [
  "code",
  "message",
  "reason",
  "notApplied",
  "overridesResolution",
  "previousOwnerEpoch",
  "beganEpoch",
  "executionStatus",
  "resolution",
  "evidence",
  "justification",
] as const;

export function toEffectAttemptView(a: EffectAttemptSource): EffectAttemptView {
  const detail: Record<string, unknown> = {};
  if (typeof a.detail === "object" && a.detail !== null) {
    const d = a.detail as Record<string, unknown>;
    for (const key of DETAIL_KEYS) {
      if (d[key] === undefined) continue;
      if (key === "evidence" && typeof d.evidence === "object" && d.evidence !== null) {
        const ev = d.evidence as Record<string, unknown>;
        detail.evidence = {
          source: typeof ev.source === "string" ? ev.source : null,
          ...(typeof ev.detail === "string" ? { detail: ev.detail } : {}),
        };
      } else if (key !== "evidence") {
        detail[key] = d[key];
      }
    }
  }
  return {
    seq: a.seq,
    event: a.event,
    actor: a.actor,
    attempt: a.epoch,
    actorUserId: a.actorUserId,
    fromStatus: a.fromStatus,
    toStatus: a.toStatus,
    applied: a.applied,
    providerReference: a.providerReference,
    at: a.createdAt.toISOString(),
    detail,
  };
}
