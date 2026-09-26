import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

/**
 * Links a Supabase Auth user (user_id, not a foreign key into our own DB —
 * users live in Supabase's auth.users table, which we never duplicate) to a
 * workspace, with a role. This is the sole authorization join point: no
 * resource query should run without checking this table first.
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueMembership: uniqueIndex("workspace_members_workspace_user_idx").on(
      table.workspaceId,
      table.userId
    ),
  })
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
export type WorkspaceRole = WorkspaceMember["role"];
