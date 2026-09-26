import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

/**
 * Integration tests for Fase 10.5A — archiving a workflow instead of
 * deleting it, against PostgreSQL (the guarantees live in row locks and in
 * the 0007 triggers, which a mock cannot exercise).
 *
 * Requires TEST_DATABASE_URL with migrations 0000-0007 applied; skipped,
 * not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 *
 * The same rules run today, against real PostgreSQL, in
 * scripts/f4f-lifecycle-harness.sql (section 9) and, for the two-session
 * races, scripts/concurrency-check.sh (scenario 7).
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("workflow archive (Fase 10.5A, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let mutations: typeof import("./mutations");
  let queries: typeof import("./queries");
  let repo: typeof import("@/server/execution/execution-repository");
  let producer: typeof import("@/server/execution/enqueue-workflow-execution");
  let runnerModule: typeof import("@/server/execution/effects/effect-runner");
  let mock: typeof import("@/server/execution/effects/test-support/mock-external-effect");
  let errors: typeof import("./errors");
  let pgErrorCode: typeof import("@/lib/db/errors").pgErrorCode;

  let workspaceA: string;
  let userA: string;

  const validDocument = {
    schemaVersion: 1,
    nodes: [{ id: "t", type: "manualTrigger", name: "t", position: { x: 0, y: 0 }, data: {} }],
    edges: [],
    settings: { executionMode: "default" },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    mutations = await import("./mutations");
    queries = await import("./queries");
    repo = await import("@/server/execution/execution-repository");
    producer = await import("@/server/execution/enqueue-workflow-execution");
    runnerModule = await import("@/server/execution/effects/effect-runner");
    mock = await import("@/server/execution/effects/test-support/mock-external-effect");
    errors = await import("./errors");
    pgErrorCode = (await import("@/lib/db/errors")).pgErrorCode;

    userA = crypto.randomUUID();
    const [ws] = await db.insert(schema.workspaces).values({ name: "10.5A archive" }).returning({ id: schema.workspaces.id });
    workspaceA = ws!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: workspaceA, userId: userA, role: "owner" });
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    // effect history is RESTRICT on purpose (0006): purge it explicitly first.
    const ops = await db
      .select({ id: schema.effectOperations.id })
      .from(schema.effectOperations)
      .where(eq(schema.effectOperations.workspaceId, workspaceA));
    if (ops.length > 0) {
      await db.delete(schema.effectAttempts).where(inArray(schema.effectAttempts.operationId, ops.map((o) => o.id)));
      await db.delete(schema.effectOperations).where(eq(schema.effectOperations.workspaceId, workspaceA));
    }
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
  });

  async function newWorkflow(name: string) {
    const wf = await mutations.createWorkflow(userA, workspaceA, { name, description: "" });
    await db.update(schema.workflows).set({ document: validDocument, status: "active" }).where(eq(schema.workflows.id, wf!.id));
    return wf!.id;
  }

  /** A workflow whose execution caused one (fake) external effect. */
  async function workflowWithEffectHistory() {
    const workflowId = await newWorkflow("with effect history");
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowId, validDocument);
    const claimed = await repo.claimQueuedExecution(created.id);
    const epoch = claimed!.claimAttempts;
    const provider = new mock.MockExternalEffect(); // fake: nothing leaves the test
    const sent = await runnerModule.createEffectRunner({ executionId: created.id, workspaceId: workspaceA, epoch }).run("send", {
      operation: "mock.send_message",
      businessKey: "lead-1",
      payload: { text: "Olá" },
      perform: provider.perform("success"),
    });
    expect(sent.status).toBe("succeeded");
    await repo.finishQueuedExecution(created.id, { status: "success", durationMs: 1, expectedClaimAttempts: epoch });
    return workflowId;
  }

  it("archives: leaves the active list, keeps status, records who", async () => {
    const workflowId = await newWorkflow("to archive");
    const result = await mutations.archiveWorkflow(userA, workspaceA, workflowId);
    expect(result.outcome).toBe("archived");
    if (result.outcome !== "archived") return;
    expect(result.workflow).toMatchObject({ status: "active", archivedBy: userA });
    expect(result.workflow.archivedAt).toBeInstanceOf(Date);

    const active = await queries.listWorkflows(userA, workspaceA);
    const archived = await queries.listWorkflows(userA, workspaceA, { archived: true });
    expect(active.map((w) => w.id)).not.toContain(workflowId);
    expect(archived.map((w) => w.id)).toContain(workflowId);

    expect((await mutations.archiveWorkflow(userA, workspaceA, workflowId)).outcome).toBe("already_archived");
  });

  it("an archived workflow is read-only and receives no executions (service and database)", async () => {
    const workflowId = await newWorkflow("read-only");
    await mutations.archiveWorkflow(userA, workspaceA, workflowId);

    await expect(mutations.updateWorkflow(userA, workspaceA, workflowId, { name: "renamed" })).rejects.toMatchObject({
      code: "WORKFLOW_ARCHIVED",
    });
    await expect(
      producer.enqueueWorkflowExecution({ userId: userA, workspaceId: workspaceA, workflowId })
    ).rejects.toMatchObject({ code: "WORKFLOW_ARCHIVED" });
    // Below the service: the trigger refuses the insert itself (WK001).
    await expect(repo.createQueuedExecution(userA, workspaceA, workflowId, validDocument)).rejects.toSatisfy(
      (err: unknown) => pgErrorCode(err) === "WK001"
    );
  });

  it("restores exactly as it was", async () => {
    const workflowId = await newWorkflow("restore me");
    await mutations.archiveWorkflow(userA, workspaceA, workflowId);
    const restored = await mutations.restoreWorkflow(userA, workspaceA, workflowId);
    expect(restored.outcome).toBe("restored");
    if (restored.outcome !== "restored") return;
    expect(restored.workflow).toMatchObject({ status: "active", archivedAt: null, archivedBy: null });
    expect((await mutations.restoreWorkflow(userA, workspaceA, workflowId)).outcome).toBe("not_archived");
    const queued = await producer.enqueueWorkflowExecution({ userId: userA, workspaceId: workspaceA, workflowId });
    expect(queued.status).toBe("queued");
  });

  it("refuses to archive while an execution is queued or running", async () => {
    const workflowId = await newWorkflow("busy");
    const queued = await producer.enqueueWorkflowExecution({ userId: userA, workspaceId: workspaceA, workflowId });
    await expect(mutations.archiveWorkflow(userA, workspaceA, workflowId)).rejects.toBeInstanceOf(errors.WorkflowConflictError);
    await expect(mutations.archiveWorkflow(userA, workspaceA, workflowId)).rejects.toMatchObject({
      code: "WORKFLOW_HAS_ACTIVE_EXECUTIONS",
    });
    // The database refuses it too, for any writer that skips the check (WK002).
    await expect(
      db.update(schema.workflows).set({ archivedAt: new Date(), archivedBy: userA }).where(eq(schema.workflows.id, workflowId))
    ).rejects.toSatisfy((err: unknown) => pgErrorCode(err) === "WK002");
    const claimed = await repo.claimQueuedExecution(queued.executionId);
    await repo.finishQueuedExecution(queued.executionId, {
      status: "success", durationMs: 1, expectedClaimAttempts: claimed!.claimAttempts,
    });
    expect((await mutations.archiveWorkflow(userA, workspaceA, workflowId)).outcome).toBe("archived");
  });

  it("delete: allowed without effect history; refused (archive instead) with it", async () => {
    const plain = await newWorkflow("plain");
    expect(await mutations.deleteWorkflow(userA, workspaceA, plain)).toEqual({ id: plain });

    const withHistory = await workflowWithEffectHistory();
    await expect(mutations.deleteWorkflow(userA, workspaceA, withHistory)).rejects.toMatchObject({
      code: "WORKFLOW_HAS_EFFECT_HISTORY",
    });
    // Nothing was removed; archiving keeps everything.
    expect(await queries.getWorkflowById(userA, workspaceA, withHistory)).not.toBeNull();
    expect((await mutations.archiveWorkflow(userA, workspaceA, withHistory)).outcome).toBe("archived");
    const ops = await db
      .select({ id: schema.effectOperations.id })
      .from(schema.effectOperations)
      .innerJoin(schema.executions, eq(schema.executions.id, schema.effectOperations.executionId))
      .where(eq(schema.executions.workflowId, withHistory));
    expect(ops).toHaveLength(1);
  });

  it("a synchronous execution stuck in 'running' does not block archiving (it cannot cause effects)", async () => {
    const workflowId = await newWorkflow("zombie sync");
    // The request died mid-run: the sync path has no recovery, by design (4G).
    const stuck = await repo.createExecution(userA, workspaceA, workflowId, validDocument);
    expect(stuck.runner).toBe("request");
    expect((await mutations.archiveWorkflow(userA, workspaceA, workflowId)).outcome).toBe("archived");
  });

  it("a non-member cannot even reach it (FORBIDDEN)", async () => {
    const workflowId = await newWorkflow("mine");
    const strangerWs = crypto.randomUUID();
    await expect(mutations.archiveWorkflow(userA, strangerWs, workflowId)).rejects.toThrow(/FORBIDDEN/);
  });

  it("another workspace of the SAME user does not see it: not_found, nothing touched", async () => {
    const workflowId = await newWorkflow("belongs to A");
    const [other] = await db.insert(schema.workspaces).values({ name: "10.5A archive B" }).returning({ id: schema.workspaces.id });
    await db.insert(schema.workspaceMembers).values({ workspaceId: other!.id, userId: userA, role: "owner" });
    try {
      expect(await mutations.archiveWorkflow(userA, other!.id, workflowId)).toEqual({ outcome: "not_found" });
      expect(await mutations.restoreWorkflow(userA, other!.id, workflowId)).toEqual({ outcome: "not_found" });
      expect(await mutations.deleteWorkflow(userA, other!.id, workflowId)).toBeNull();
      const row = await queries.getWorkflowById(userA, workspaceA, workflowId);
      expect(row?.archivedAt).toBeNull();
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, other!.id));
    }
  });
});
