export const calls: string[] = [];
export async function ensureDefaultWorkspace(userId: string, _label: string) { calls.push(userId); return `ws-of-${userId}`; }
