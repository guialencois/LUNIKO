type Row = Record<string, unknown>;
export const calls: { fn: string; args: unknown[] }[] = [];
export const script: {
  archive: () => Promise<{ outcome: "archived"; workflow: Row } | { outcome: "already_archived"; workflow: Row } | { outcome: "not_found" }>;
  restore: () => Promise<{ outcome: "restored"; workflow: Row } | { outcome: "not_archived"; workflow: Row } | { outcome: "not_found" }>;
  update: () => Promise<Row | null>;
  remove: () => Promise<{ id: string } | null>;
} = {
  archive: async () => ({ outcome: "not_found" }),
  restore: async () => ({ outcome: "not_found" }),
  update: async () => null,
  remove: async () => null,
};
export async function archiveWorkflow(...args: unknown[]) { calls.push({ fn: "archive", args }); return script.archive(); }
export async function restoreWorkflow(...args: unknown[]) { calls.push({ fn: "restore", args }); return script.restore(); }
export async function updateWorkflow(...args: unknown[]) { calls.push({ fn: "update", args }); return script.update(); }
export async function deleteWorkflow(...args: unknown[]) { calls.push({ fn: "delete", args }); return script.remove(); }
export async function createWorkflow(...args: unknown[]) { calls.push({ fn: "create", args }); return { id: "wf-new" }; }
