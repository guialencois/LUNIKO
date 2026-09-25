export const calls: { fn: string; args: unknown[] }[] = [];
export const script: { enqueue: () => Promise<{ executionId: string; status: "queued" }> } = {
  enqueue: async () => ({ executionId: "ex-2", status: "queued" }),
};
export async function enqueueWorkflowExecution(input: { userId: string; workspaceId: string; workflowId: string }) {
  calls.push({ fn: "enqueue", args: [input] });
  return script.enqueue();
}
