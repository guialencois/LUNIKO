// Scripted stand-in for the repository: records every call, answers what
// the test scripted. The HTTP translation is what is under test here.
import type { EffectOperationSource, EffectAttemptSource } from "./effect-view";
import type { ResolveEffectInput } from "./resolution";
import type { EffectStatus } from "./effect-decision";
export type ResolveEffectResult =
  | { outcome: "resolved"; operation: unknown }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "not_unknown"; status: string }
  | { outcome: "execution_active"; executionStatus: string }
  | { outcome: "too_early"; resolvableFrom: Date };
export const calls: { fn: string; args: unknown[] }[] = [];
export const script: {
  list: () => Promise<EffectOperationSource[]>;
  detail: () => Promise<(EffectOperationSource & { attempts: EffectAttemptSource[] }) | null>;
  resolve: () => Promise<ResolveEffectResult>;
} = {
  list: async () => [],
  detail: async () => null,
  resolve: async () => ({ outcome: "not_found" }),
};
export async function listEffectOperations(userId: string, workspaceId: string, filter: { status?: EffectStatus; limit?: number } = {}) {
  calls.push({ fn: "list", args: [userId, workspaceId, filter] });
  return script.list();
}
export async function getEffectOperationDetail(userId: string, workspaceId: string, operationId: string) {
  calls.push({ fn: "detail", args: [userId, workspaceId, operationId] });
  return script.detail();
}
export async function resolveUnknownEffectOperation(
  userId: string, workspaceId: string, operationId: string, input: ResolveEffectInput, ...rest: unknown[]
): Promise<ResolveEffectResult> {
  calls.push({ fn: "resolve", args: [userId, workspaceId, operationId, input, ...rest] });
  return script.resolve();
}
