// Scripted stand-in for the sync service: records the call, answers what the
// test scripted. Its own behaviour is covered elsewhere.
export interface ExecuteWorkflowInput {
  userId: string;
  workspaceId: string;
  workflowId: string;
  input?: unknown;
}
export const calls: { fn: string; args: unknown[] }[] = [];
export const script: { execute: () => Promise<unknown> } = { execute: async () => ({ executionId: "ex-1", status: "success" }) };
export async function executeWorkflow(input: ExecuteWorkflowInput) {
  calls.push({ fn: "execute", args: [input] });
  return script.execute() as Promise<{ executionId: string; status: "success" | "error" | "cancelled" }>;
}
