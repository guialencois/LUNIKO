import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { workflows } from "./workflows";

/**
 * Fase 5A — a URL pública de um nó webhookTrigger
 * (db/migrations/0009_webhook_trigger.sql, docs/webhook-trigger.md).
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    token: text("token").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUnique: unique("webhook_endpoints_token_unique").on(table.token),
    workflowNodeUnique: unique("webhook_endpoints_workflow_node_unique").on(
      table.workflowId,
      table.nodeId
    ),
    workspaceIdx: index("webhook_endpoints_workspace_idx").on(table.workspaceId),
  })
);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
