export declare function requireWorkspaceMembership(userId: string, workspaceId: string): Promise<{ role: "owner" | "admin" | "member" | "viewer" }>;
