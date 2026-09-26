// MODELO DE TIPOS (não é Drizzle): linhas e inserts escritos à mão a partir de
// lib/db/schema/effects.ts, executions.ts e workflows.ts, com os enums das
// colunas (0006 + 0007).
import type { WorkflowDocument } from "@/lib/workflows/types";
export type EffectStatus = "reserved" | "in_flight" | "succeeded" | "failed" | "unknown";
export type EffectResolution = "confirmed_sent" | "confirmed_not_sent" | "confirmed_rejected";
export interface EffectOperationRow {
  id: string; executionId: string; workspaceId: string; nodeId: string; businessKey: string;
  operation: string; idempotencyKey: string; deliveryPolicy: "at_most_once"; payloadFingerprint: string;
  status: EffectStatus; ownerEpoch: number; beganEpoch: number | null; providerReference: string | null;
  lastError: unknown; resolvedByUserId: string | null; resolution: EffectResolution | null;
  createdAt: Date; updatedAt: Date;
}
export interface EffectOperationInsert {
  id?: string; executionId: string; workspaceId: string; nodeId: string; businessKey: string;
  operation: string; idempotencyKey: string; deliveryPolicy?: "at_most_once"; payloadFingerprint: string;
  status: EffectStatus; ownerEpoch: number; beganEpoch?: number | null; providerReference?: string | null;
  lastError?: unknown; resolvedByUserId?: string | null; resolution?: EffectResolution | null;
  createdAt?: Date; updatedAt?: Date;
}
export interface EffectAttemptRow {
  id: string; seq: number; operationId: string;
  event: "reserved" | "adopted" | "began" | "succeeded" | "failed" | "unknown" | "resolved";
  actor: "worker" | "user" | "system"; epoch: number | null; actorUserId: string | null;
  fromStatus: string | null; toStatus: string; applied: boolean; providerReference: string | null;
  detail: unknown; createdAt: Date;
}
export type EffectAttemptInsert = Omit<EffectAttemptRow, "id" | "seq" | "createdAt" | "epoch" | "actorUserId" | "fromStatus" | "providerReference" | "detail"> &
  Partial<Pick<EffectAttemptRow, "id" | "seq" | "createdAt" | "epoch" | "actorUserId" | "fromStatus" | "providerReference" | "detail">>;
export interface Column<T> { readonly __t?: T }
export interface Table<Row, Insert, Cols> { readonly __row: Row; readonly __insert: Insert; readonly cols: Cols }
type ColsOf<R> = { [K in keyof R]-?: Column<R[K]> };
export declare const effectOperations: Table<EffectOperationRow, EffectOperationInsert, never> & ColsOf<EffectOperationRow>;
export declare const effectAttempts: Table<EffectAttemptRow, EffectAttemptInsert, never> & ColsOf<EffectAttemptRow>;
export interface ExecutionRowLite {
  id: string; workflowId: string; workspaceId: string; runner: "request" | "worker";
  status: "queued" | "running" | "success" | "error" | "cancelled"; claimAttempts: number;
}
export declare const executions: Table<ExecutionRowLite, never, never> & ColsOf<ExecutionRowLite>;
export interface WorkflowRow {
  id: string; workspaceId: string; name: string; description: string; status: "draft" | "active" | "inactive";
  document: WorkflowDocument; createdBy: string; createdAt: Date; updatedAt: Date;
  archivedAt: Date | null; archivedBy: string | null;
}
export interface WorkflowInsert {
  id?: string; workspaceId: string; name: string; description?: string; status?: "draft" | "active" | "inactive";
  document: WorkflowDocument; createdBy: string; createdAt?: Date; updatedAt?: Date;
  archivedAt?: Date | null; archivedBy?: string | null;
}
export declare const workflows: Table<WorkflowRow, WorkflowInsert, never> & ColsOf<WorkflowRow>;
