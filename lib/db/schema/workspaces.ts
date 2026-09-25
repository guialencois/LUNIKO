import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A workspace is the top-level tenant boundary. Every resource created in
 * later phases (workflows, credentials, executions, ...) belongs to a
 * workspace_id, and every query must filter by it — see lib/auth/session.ts.
 */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
