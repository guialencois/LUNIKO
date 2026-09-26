import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, bigserial, index, unique } from "drizzle-orm/pg-core";
import { executions } from "./executions";
import { workspaces } from "./workspaces";

/**
 * Durable record of one logical operation performed OUTSIDE this system.
 * See db/migrations/0006_effect_operations.sql for the invariants the
 * database enforces, and server/execution/effects/ for the protocol.
 *
 * Not declared here, because Drizzle has no notation for them, and enforced
 * by the migration all the same: the CHECK constraints on status/epochs,
 * the transition guard on effect_operations (began_epoch written once,
 * owner_epoch only grows, no way back to "reserved", identity immutable),
 * the append-only trigger on effect_attempts, and the trigger on
 * `executions` that turns an in_flight operation into `unknown` in the same
 * commit that makes its execution terminal.
 */
export const effectOperations = pgTable(
  "effect_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // RESTRICT, never CASCADE: evidence of an external effect is not deleted
    // as a side effect of deleting something else.
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "restrict" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    nodeId: text("node_id").notNull(),
    businessKey: text("business_key").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveryPolicy: text("delivery_policy", { enum: ["at_most_once"] })
      .notNull()
      .default("at_most_once"),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    status: text("status", {
      enum: ["reserved", "in_flight", "succeeded", "failed", "unknown"],
    }).notNull(),
    ownerEpoch: integer("owner_epoch").notNull(),
    beganEpoch: integer("began_epoch"),
    providerReference: text("provider_reference"),
    lastError: jsonb("last_error"),
    // Set when a PERSON decided the final state; NULL when the provider did.
    resolvedByUserId: uuid("resolved_by_user_id"),
    // What that person decided (0007): set exactly when resolvedByUserId is.
    resolution: text("resolution", {
      enum: ["confirmed_sent", "confirmed_not_sent", "confirmed_rejected"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyKeyUnique: unique("effect_operations_idempotency_key_unique").on(table.idempotencyKey),
    executionIdx: index("effect_operations_execution_idx").on(table.executionId),
  })
);

/** Append-only: one immutable fact per row. UPDATE is rejected by a trigger. */
export const effectAttempts = pgTable(
  "effect_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Insertion order — the order of the facts. createdAt cannot give it:
    // two events written in one transaction share now().
    seq: bigserial("seq", { mode: "number" }).notNull(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => effectOperations.id, { onDelete: "restrict" }),
    event: text("event", {
      enum: ["reserved", "adopted", "began", "succeeded", "failed", "unknown", "resolved"],
    }).notNull(),
    // "system": written by the database itself when an execution becomes
    // terminal with an operation still in flight (trigger in 0006).
    actor: text("actor", { enum: ["worker", "user", "system"] }).notNull(),
    epoch: integer("epoch"),
    actorUserId: uuid("actor_user_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    applied: boolean("applied").notNull(),
    providerReference: text("provider_reference"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operationIdx: index("effect_attempts_operation_idx").on(table.operationId, table.seq),
  })
);

export type EffectOperationRow = typeof effectOperations.$inferSelect;
export type EffectAttemptRow = typeof effectAttempts.$inferSelect;
