export const calls: { fn: string; args: unknown[] }[] = [];
export async function listWorkflows(...args: unknown[]) { calls.push({ fn: "list", args }); return [{ id: "wf-1" }]; }
export async function getWorkflowById(...args: unknown[]) { calls.push({ fn: "get", args }); return null; }
