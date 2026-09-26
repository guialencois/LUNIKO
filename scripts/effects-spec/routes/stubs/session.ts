export const session: { user: { id: string; email: string | null } | null } = { user: null };
export async function getCurrentUser() { return session.user; }
