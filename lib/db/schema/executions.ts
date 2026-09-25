import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { workflows } from "./workflows";
import { workspaces } from "./workspaces";

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "success", "error", "cancelled"],
    })
      .notNull()
      .default("queued"),
    // Snapshot of the WorkflowDocument that was actually executed (item 37
    // — Fase 2 has no workflow_versions table, this is the minimal "clear
    // reference to the executed document" the spec asks for instead).
    document: jsonb("document").notNull(),
    triggerType: text("trigger_type", { enum: ["manual"] }).notNull().default("manual"),
    // Fase 4G: qual lifecycle é dono desta execução (0004_execution_runner.sql).
    // "request" = roda dentro de uma request HTTP viva (caminho síncrono),
    // nunca enfileirada e nunca tocada pelo reaper. "worker" = pertence à
    // fila. O banco garante que uma execução "request" não pode estar
    // "queued" (executions_request_never_queued_check).
    runner: text("runner", { enum: ["request", "worker"] }).notNull().default("request"),
    // Fase 4C: lifecycle assíncrono (docs/async-execution.md).
    result: jsonb("result"),
    claimAttempts: integer("claim_attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    // Fase 9: até quando o dono do claim corrente afirmou que continua
    // vivo (0005_execution_lease.sql). Concedido no claim, renovado pelo
    // worker durante a execução, sempre sob a mesma época de fencing.
    // NULL para qualquer linha sem dono — fila ou estado terminal — e o
    // banco garante isso (executions_lease_only_while_running_check).
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    error: jsonb("error"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowIdx: index("executions_workflow_idx").on(table.workflowId),
    workspaceIdx: index("executions_workspace_idx").on(table.workspaceId),
  })
);

export const executionNodes = pgTable(
  "execution_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status", { enum: ["success", "error"] }).notNull(),
    // Redacted before insert — see server/execution/execution-repository.ts.
    input: jsonb("input"),
    output: jsonb("output"),
    error: jsonb("error"),
    durationMs: integer("duration_ms").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    executionIdx: index("execution_nodes_execution_idx").on(table.executionId),
  })
);

export type ExecutionRow = typeof executions.$inferSelect;
export type NewExecutionRow = typeof executions.$inferInsert;
export type ExecutionNodeRow = typeof executionNodes.$inferSelect;
export type NewExecutionNodeRow = typeof executionNodes.$inferInsert;
