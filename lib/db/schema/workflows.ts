import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import type { WorkflowDocument } from "@/lib/workflows/types";

/**
 * A workflow belongs to exactly one workspace. `document` stores the full
 * WorkflowDocument (nodes, edges, settings) as jsonb — never as a text blob
 * of pre-serialized JSON, so it stays queryable in Postgres if needed later.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["draft", "active", "inactive"] })
      .notNull()
      .default("draft"),
    document: jsonb("document").notNull().$type<WorkflowDocument>(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Fase 10.5A (0007): archived instead of deleted when it has external-
    // effect history. Both set or both null. Orthogonal to `status`. The
    // database refuses new executions for an archived workflow, and refuses
    // archiving while it has queued/running ones.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by"),
  },
  (table) => ({
    workspaceIdx: index("workflows_workspace_idx").on(table.workspaceId),
  })
);

export type WorkflowRow = typeof workflows.$inferSelect;
export type NewWorkflowRow = typeof workflows.$inferInsert;
