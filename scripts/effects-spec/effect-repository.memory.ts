/**
 * IN-MEMORY STAND-IN for server/execution/effects/effect-repository.ts, used
 * ONLY to run the real effect-runner.ts under Node without drizzle/postgres
 * (npm 403: node_modules cannot be installed here).
 *
 * Every function mirrors the WHERE clause of its real counterpart, one line
 * per condition, and each one is ONE atomic step (no await inside the body),
 * which is what the real transaction + row locks give. The same conditions
 * are exercised against real PostgreSQL in scripts/f4f-lifecycle-harness.sql
 * (sections 8-9) and scripts/concurrency-check.sh (scenarios 6-9).
 *
 * Fase 10.5A: the resolution model (resolveUnknown) mirrors
 * resolveUnknownEffectOperation minus the membership/role check, which is
 * plain SQL covered by the harness. The request it receives has already
 * passed the REAL validator (resolution.ts), as in the route.
 *
 * Rows handed out are COPIES, like rows read from a database: the runner
 * decides on a snapshot that can go stale, exactly as in production.
 */
import type { ProviderCallOutcome } from "@/lib/execution/effects";
import type { EffectOperationSnapshot, EffectStatus } from "./effect-decision";
import {
  EFFECT_RESOLUTIONS,
  EVIDENCE_SOURCES,
  RESOLUTION_COOLING_PERIOD_SECONDS,
  TERMINAL_EXECUTION_STATUSES,
  statusForResolution,
  type EffectResolution,
  type ResolveEffectInput,
} from "./resolution";

export interface EffectOperationRow {
  id: string;
  executionId: string;
  workspaceId: string;
  nodeId: string;
  businessKey: string;
  operation: string;
  idempotencyKey: string;
  deliveryPolicy: "at_most_once";
  payloadFingerprint: string;
  status: EffectStatus;
  ownerEpoch: number;
  beganEpoch: number | null;
  providerReference: string | null;
  lastError: unknown;
  resolvedByUserId: string | null;
  resolution: EffectResolution | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EffectAttemptRow {
  seq: number;
  operationId: string;
  event: "reserved" | "adopted" | "began" | "succeeded" | "failed" | "unknown" | "resolved";
  actor: "worker" | "user" | "system";
  epoch: number | null;
  actorUserId: string | null;
  fromStatus: string | null;
  toStatus: string;
  applied: boolean;
  providerReference: string | null;
  detail: unknown;
  createdAt: Date;
}

interface ExecutionState {
  workspaceId: string;
  runner: "worker" | "request";
  status: "queued" | "running" | "success" | "error" | "cancelled";
  claimAttempts: number;
}

export const memdb = {
  executions: new Map<string, ExecutionState>(),
  operations: new Map<string, EffectOperationRow>(),
  attempts: [] as EffectAttemptRow[],
  /** Fault injection. */
  faults: {
    /** Awaited BEFORE begin's transaction is sent. Returning "crash" never
     *  resolves: the process died and the transaction never committed. */
    beforeBegin: null as null | ((epoch: number) => Promise<"proceed" | "crash">),
    /** recordEffectOutcome throws this many more times (a database error). */
    recordFailures: 0,
  },
  /** The DATABASE's clock (now()): the cooling period is measured on it,
   *  never on the app server's. A spec moves it forward explicitly. */
  clock: (): Date => new Date(),
  reset(): void {
    this.executions.clear();
    this.operations.clear();
    this.attempts.length = 0;
    this.faults.beforeBegin = null;
    this.faults.recordFailures = 0;
    this.clock = () => new Date();
  },
};

let idSeq = 0;

/** Mirror of trigger effect_operations_guard (0006, as redefined by 0007):
 *  the database refuses any transition outside the state machine. Called on
 *  every mutation. */
function guard(before: EffectOperationRow, after: EffectOperationRow): void {
  const idCols = ["executionId", "workspaceId", "nodeId", "businessKey", "operation",
    "idempotencyKey", "payloadFingerprint", "deliveryPolicy"] as const;
  for (const c of idCols) if (before[c] !== after[c]) throw new Error(`guard: identity column ${c} changed`);
  if (before.beganEpoch !== null && after.beganEpoch !== before.beganEpoch) throw new Error("guard: began_epoch rewritten");
  if (after.ownerEpoch < before.ownerEpoch) throw new Error("guard: owner_epoch decreased");
  if (before.resolvedByUserId === null && after.resolvedByUserId !== null && before.status !== "unknown")
    throw new Error("guard: resolution of a non-unknown operation");
  const o = before.status, n = after.status;
  const ok =
    (o === "reserved" && (n === "reserved" || n === "in_flight")) ||
    (o === "in_flight" && n !== "reserved") ||
    (o === "unknown" && (n === "unknown" || n === "succeeded" || n === "failed")) ||
    ((o === "succeeded" || o === "failed") && (n === "succeeded" || n === "failed") &&
      // nothing about the outcome changes...
      ((n === o && after.providerReference === before.providerReference &&
          JSON.stringify(after.lastError) === JSON.stringify(before.lastError) &&
          after.resolvedByUserId === before.resolvedByUserId && after.resolution === before.resolution) ||
        // ...or a provider fact replaces a person's judgment (0007: never a
        // person over a person)
        (before.resolvedByUserId !== null && after.resolvedByUserId === null)));
  if (!ok) throw new Error(`guard: transition ${o} -> ${n} is not allowed`);
  // CHECKs
  if ((after.status === "reserved") !== (after.beganEpoch === null)) throw new Error("check: began_iff_not_reserved");
  if (after.status === "succeeded" && !(after.providerReference && after.providerReference.length > 0))
    throw new Error("check: success_has_reference");
  if (after.resolvedByUserId !== null && after.status !== "succeeded" && after.status !== "failed")
    throw new Error("check: resolution_is_final");
  // 0007 effect_operations_resolution_matches
  if ((after.resolution === null) !== (after.resolvedByUserId === null) ||
      (after.resolution !== null &&
        !((after.resolution === "confirmed_sent" && after.status === "succeeded") ||
          (after.resolution !== "confirmed_sent" && after.status === "failed"))))
    throw new Error("check: resolution_matches");
}

/** Mirror of 0007 effect_attempts_resolution_has_evidence (the coalesced
 *  version: a missing key refuses, as in PostgreSQL). Lengths as btrim +
 *  length() count them: characters, surrounding spaces excluded. */
function checkResolvedEvent(a: Omit<EffectAttemptRow, "seq" | "createdAt">): void {
  if (a.event !== "resolved") return;
  const d = (a.detail ?? {}) as { resolution?: unknown; justification?: unknown; evidence?: { source?: unknown; detail?: unknown } };
  const chars = (v: unknown) => (typeof v === "string" ? Array.from(v.replace(/^ +| +$/g, "")).length : 0);
  const ok =
    a.actor === "user" &&
    a.fromStatus === "unknown" &&
    (EFFECT_RESOLUTIONS as readonly unknown[]).includes(d.resolution) &&
    chars(d.justification) >= 10 &&
    (EVIDENCE_SOURCES as readonly unknown[]).includes(d.evidence?.source) &&
    (d.resolution === "confirmed_sent"
      ? a.providerReference !== null && a.providerReference.length > 0
      : chars(d.evidence?.detail) >= 5);
  if (!ok) throw new Error("check: resolution_has_evidence");
}

/** Applies a mutation through the guard, like an UPDATE through the trigger. */
function mutate(op: EffectOperationRow, change: Partial<EffectOperationRow>): void {
  const next = { ...op, ...change, updatedAt: new Date() };
  guard(op, next);
  Object.assign(op, next);
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const copy = <T>(v: T): T => structuredClone(v);

function appendAttempt(a: Omit<EffectAttemptRow, "seq" | "createdAt">): void {
  checkResolvedEvent(a);
  memdb.attempts.push({ seq: memdb.attempts.length + 1, ...a, createdAt: memdb.clock() });
}

// ---- execution lifecycle, mirroring execution-repository.ts ------------------

export function createQueuedExecution(executionId: string, workspaceId = "ws-1"): void {
  memdb.executions.set(executionId, { workspaceId, runner: "worker", status: "queued", claimAttempts: 0 });
}

export function createSyncExecution(executionId: string, workspaceId = "ws-1"): void {
  memdb.executions.set(executionId, { workspaceId, runner: "request", status: "running", claimAttempts: 0 });
}

/** claimQueuedExecution: queued -> running, claim_attempts + 1. Returns the epoch. */
export function claim(executionId: string): number | null {
  const e = memdb.executions.get(executionId);
  if (!e || e.runner !== "worker" || e.status !== "queued") return null;
  e.status = "running";
  e.claimAttempts += 1;
  return e.claimAttempts;
}

/** reclaimExpiredExecution (lease already expired): running -> queued, no increment. */
export function reclaim(executionId: string, maxAttempts = 3): boolean {
  const e = memdb.executions.get(executionId);
  if (!e || e.runner !== "worker" || e.status !== "running" || !(e.claimAttempts < maxAttempts)) return false;
  e.status = "queued";
  return true;
}

/** The trigger executions_settle_effects_on_terminal (0006), same commit. */
function settleOnTerminal(executionId: string, executionStatus: string): void {
  for (const op of memdb.operations.values()) {
    if (op.executionId !== executionId || op.status !== "in_flight") continue;
    mutate(op, {
      status: "unknown",
      lastError: { code: "EXTERNAL_EFFECT_UNKNOWN", message: "the execution ended while this operation was in flight" },
    });
    appendAttempt({
      operationId: op.id, event: "unknown", actor: "system", epoch: null, actorUserId: null,
      fromStatus: "in_flight", toStatus: "unknown", applied: true, providerReference: null,
      detail: {
        reason: "the execution reached a terminal state while this operation was in flight",
        executionStatus, beganEpoch: op.beganEpoch,
      },
    });
  }
}

/** finishQueuedExecution: fenced by runner + status + epoch. */
export function finish(executionId: string, epoch: number, status: "success" | "error" | "cancelled"): boolean {
  const e = memdb.executions.get(executionId);
  if (!e || e.runner !== "worker" || e.status !== "running" || e.claimAttempts !== epoch) return false;
  e.status = status;
  settleOnTerminal(executionId, status);
  return true;
}

/** A cancellation of an execution that is NOT running (e.g. back in the
 *  queue after a reclaim) — a path that does not exist yet, and that the
 *  trigger must cover anyway: any non-terminal -> terminal. */
export function cancel(executionId: string): boolean {
  const e = memdb.executions.get(executionId);
  if (!e || e.status === "success" || e.status === "error" || e.status === "cancelled") return false;
  e.status = "cancelled";
  settleOnTerminal(executionId, "cancelled");
  return true;
}

/** abandonExecution (lease expired, attempts exhausted). */
export function abandon(executionId: string, maxAttempts = 3): boolean {
  const e = memdb.executions.get(executionId);
  if (!e || e.runner !== "worker" || e.status !== "running" || !(e.claimAttempts >= maxAttempts)) return false;
  e.status = "error";
  settleOnTerminal(executionId, "error");
  return true;
}

// ---- the repository API the runner imports ---------------------------------

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

/** SELECT ... FROM executions WHERE id AND runner='worker' AND status='running'
 *  AND claim_attempts = epoch FOR SHARE */
function executionOwnedBy(executionId: string, epoch: number): boolean {
  const e = memdb.executions.get(executionId);
  return Boolean(e && e.runner === "worker" && e.status === "running" && e.claimAttempts === epoch);
}

function byKey(idempotencyKey: string): EffectOperationRow | undefined {
  for (const op of memdb.operations.values()) if (op.idempotencyKey === idempotencyKey) return op;
  return undefined;
}

export async function getEffectOperationByKey(idempotencyKey: string): Promise<EffectOperationRow | null> {
  await tick();
  const op = byKey(idempotencyKey);
  return op ? copy(op) : null;
}

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

export async function reserveEffectOperation(input: ReserveInput): Promise<ReserveResult> {
  await tick();
  if (!executionOwnedBy(input.executionId, input.epoch)) return { outcome: "fenced" };

  // INSERT ... ON CONFLICT (idempotency_key) DO NOTHING
  const existing = byKey(input.idempotencyKey);
  if (existing) return { outcome: "exists", op: copy(existing) };

  const now = new Date();
  const op: EffectOperationRow = {
    id: `op-${++idSeq}`,
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
    beganEpoch: null,
    providerReference: null,
    lastError: null,
    resolvedByUserId: null,
    resolution: null,
    createdAt: now,
    updatedAt: now,
  };
  memdb.operations.set(op.id, op);
  appendAttempt({
    operationId: op.id, event: "reserved", actor: "worker", epoch: input.epoch, actorUserId: null,
    fromStatus: null, toStatus: "reserved", applied: true, providerReference: null, detail: null,
  });
  return { outcome: "reserved", op: copy(op) };
}

export async function adoptEffectOperation(input: {
  operationId: string;
  executionId: string;
  epoch: number;
}): Promise<TransitionResult> {
  await tick();
  if (!executionOwnedBy(input.executionId, input.epoch)) return { outcome: "fenced" };
  const op = memdb.operations.get(input.operationId);
  if (!op) return { outcome: "stale" };
  if (op.executionId !== input.executionId) return { outcome: "fenced" };
  if (op.ownerEpoch >= input.epoch) return { outcome: "stale" };
  if (op.status !== "reserved" && op.status !== "in_flight") return { outcome: "stale" };

  const from = op.status;
  const nextStatus: EffectStatus = from === "in_flight" ? "unknown" : "reserved";
  const previousOwnerEpoch = op.ownerEpoch;
  mutate(op, { ownerEpoch: input.epoch, status: nextStatus });
  appendAttempt({
    operationId: op.id, event: "adopted", actor: "worker", epoch: input.epoch, actorUserId: null,
    fromStatus: from, toStatus: nextStatus, applied: true, providerReference: null,
    detail: { previousOwnerEpoch },
  });
  if (nextStatus === "unknown") {
    appendAttempt({
      operationId: op.id, event: "unknown", actor: "worker", epoch: input.epoch, actorUserId: null,
      fromStatus: "in_flight", toStatus: "unknown", applied: true, providerReference: null,
      detail: {
        reason: "a previous attempt crossed the point of no return and never reported an outcome",
        beganEpoch: op.beganEpoch,
      },
    });
  }
  return { outcome: "done", op: copy(op) };
}

export async function beginEffectOperation(input: {
  operationId: string;
  executionId: string;
  epoch: number;
}): Promise<TransitionResult> {
  if (memdb.faults.beforeBegin) {
    const gate = await memdb.faults.beforeBegin(input.epoch);
    if (gate === "crash") return new Promise<TransitionResult>(() => {}); // never committed
  }
  await tick();
  if (!executionOwnedBy(input.executionId, input.epoch)) return { outcome: "fenced" };
  const op = memdb.operations.get(input.operationId);
  if (!op) return { outcome: "stale" };
  if (op.executionId !== input.executionId) return { outcome: "fenced" };
  if (op.ownerEpoch !== input.epoch || op.status !== "reserved" || op.beganEpoch !== null) {
    return { outcome: "stale" };
  }
  mutate(op, { status: "in_flight", beganEpoch: input.epoch });
  appendAttempt({
    operationId: op.id, event: "began", actor: "worker", epoch: input.epoch, actorUserId: null,
    fromStatus: "reserved", toStatus: "in_flight", applied: true, providerReference: null, detail: null,
  });
  return { outcome: "done", op: copy(op) };
}

export async function recordEffectOutcome(input: {
  operationId: string;
  executionId: string;
  epoch: number;
  outcome: ProviderCallOutcome;
}): Promise<EffectOperationRow | null> {
  await tick();
  if (memdb.faults.recordFailures > 0) {
    memdb.faults.recordFailures--;
    throw new Error("simulated database error while recording the outcome");
  }
  const op = memdb.operations.get(input.operationId);
  if (!op) return null;

  const target: "succeeded" | "failed" | "unknown" =
    input.outcome.kind === "succeeded" ? "succeeded" : input.outcome.kind === "failed" ? "failed" : "unknown";
  const overridesResolution =
    target !== "unknown" && (op.status === "succeeded" || op.status === "failed") && op.resolvedByUserId !== null;
  const fromPending = target === "unknown" ? op.status === "in_flight" : op.status === "in_flight" || op.status === "unknown";
  const authored = op.executionId === input.executionId && op.beganEpoch === input.epoch;
  const applies = authored && (fromPending || overridesResolution);
  const from = op.status;
  const previousResolver = op.resolvedByUserId;
  const previousResolution = op.resolution;

  if (applies) {
    mutate(op, {
      status: target,
      providerReference: input.outcome.kind === "succeeded" ? input.outcome.providerReference : null,
      lastError:
        input.outcome.kind === "failed"
          ? { code: input.outcome.code, message: input.outcome.message }
          : input.outcome.kind === "unknown"
            ? { code: "EXTERNAL_EFFECT_UNKNOWN", message: input.outcome.reason }
            : null,
      resolvedByUserId: null,
      resolution: null,
    });
  }

  appendAttempt({
    operationId: op.id, event: target, actor: "worker", epoch: input.epoch, actorUserId: null,
    fromStatus: from, toStatus: op.status, applied: applies,
    providerReference: input.outcome.kind === "succeeded" ? input.outcome.providerReference : null,
    detail: {
      ...(input.outcome.kind === "failed"
        ? { code: input.outcome.code, message: input.outcome.message }
        : input.outcome.kind === "unknown"
          ? { reason: input.outcome.reason }
          : {}),
      ...(authored ? {} : { notApplied: "reported by an epoch that did not make the call" }),
      ...(authored && !applies ? { notApplied: `operation was already ${from}` } : {}),
      ...(applies && overridesResolution
        ? { overridesResolution: { status: from, resolution: previousResolution, resolvedByUserId: previousResolver } }
        : {}),
    },
  });
  return copy(op);
}

export type ResolveResult =
  | { outcome: "resolved"; operation: EffectOperationRow }
  | { outcome: "not_found" }
  | { outcome: "not_unknown"; status: string }
  | { outcome: "execution_active"; executionStatus: string }
  | { outcome: "too_early"; resolvableFrom: Date };

/** resolveUnknownEffectOperation (MODELO 1, Fase 10.5A), minus the
 *  membership/role check. Same order of refusals, one atomic step. */
export async function resolveUnknown(
  operationId: string,
  userId: string,
  input: ResolveEffectInput,
  options: { coolingPeriodSeconds?: number } = {}
): Promise<ResolveResult> {
  const cooling = options.coolingPeriodSeconds ?? RESOLUTION_COOLING_PERIOD_SECONDS;
  await tick();
  const op = memdb.operations.get(operationId);
  if (!op) return { outcome: "not_found" };
  if (op.status !== "unknown") return { outcome: "not_unknown", status: op.status };
  const execution = memdb.executions.get(op.executionId);
  if (!execution || !(TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(execution.status)) {
    return { outcome: "execution_active", executionStatus: execution?.status ?? "missing" };
  }
  const began = memdb.attempts
    .filter((a) => a.operationId === op.id && a.event === "began")
    .reduce<Date | null>((min, a) => (min === null || a.createdAt < min ? a.createdAt : min), null);
  const resolvableFrom = new Date((began ?? op.createdAt).getTime() + cooling * 1000);
  if (resolvableFrom.getTime() > memdb.clock().getTime()) return { outcome: "too_early", resolvableFrom };

  const status = statusForResolution(input.resolution);
  const fact: Omit<EffectAttemptRow, "seq" | "createdAt"> = {
    operationId: op.id, event: "resolved", actor: "user", epoch: null, actorUserId: userId,
    fromStatus: "unknown", toStatus: status, applied: true,
    providerReference: input.providerReference ?? null,
    detail: {
      resolution: input.resolution,
      evidence: {
        source: input.evidence.source,
        ...(input.evidence.detail ? { detail: input.evidence.detail } : {}),
      },
      justification: input.justification,
    },
  };
  // One transaction: if the database refuses the fact (0007 CHECK), the
  // state change rolls back with it — so the fact is checked first here.
  checkResolvedEvent(fact);
  mutate(op, {
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
  });
  appendAttempt(fact);
  return { outcome: "resolved", operation: copy(op) };
}

/** A write that goes around the repository, as a direct SQL UPDATE would —
 *  for the spec to show the guard/CHECK mirrors refuse it. A raw write
 *  records no fact, so any change of WHO decided is refused too: mirror of
 *  the 0007 constraint trigger effect_operations_resolution_is_recorded
 *  (checked at commit in PostgreSQL). */
export function rawUpdate(operationId: string, change: Partial<EffectOperationRow>): void {
  const op = memdb.operations.get(operationId);
  if (!op) throw new Error("no such operation");
  const next = { ...op, ...change, updatedAt: new Date() };
  guard(op, next);
  if (next.resolvedByUserId !== op.resolvedByUserId) throw new Error("trigger: resolution_is_recorded");
  Object.assign(op, next);
}
