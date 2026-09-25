import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

/**
 * Integration tests for the 4D Postgres-based queue. Same rationale as
 * execution-lifecycle.integration.test.ts (4C) and
 * workflows.integration.test.ts (Fase 2): concurrency guarantees
 * (FOR UPDATE SKIP LOCKED, two concurrent claimers never colliding) are
 * not meaningfully testable against a mock — they depend on real Postgres
 * locking. Requires TEST_DATABASE_URL with migrations 0000-0003 applied;
 * skipped, not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("execution queue (4D, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("./execution-repository");
  let queue: typeof import("./execution-queue");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let userA: string;
  let workflowA: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("./execution-repository");
    queue = await import("./execution-queue");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "4D Test Workspace" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA.id;

    await db.insert(schema.workspaceMembers).values({
      workspaceId: workspaceA,
      userId: userA,
      role: "owner",
    });

    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "4D test workflow",
      description: "",
    });
    workflowA = workflow.id;
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
  });

  async function createQueued() {
    return repo.createQueuedExecution(userA, workspaceA, workflowA, {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: { executionMode: "default" },
    });
  }

  it("1. enqueues a valid, currently-queued execution", async () => {
    const created = await createQueued();
    const job = await queue.enqueueExecution(created.id);
    expect(job.executionId).toBe(created.id);
  });

  it("2. the job payload contains only executionId", async () => {
    const created = await createQueued();
    const job = await queue.enqueueExecution(created.id);
    expect(Object.keys(job)).toEqual(["executionId"]);
  });

  it("3. an execution that doesn't exist cannot be enqueued", async () => {
    await expect(queue.enqueueExecution(crypto.randomUUID())).rejects.toMatchObject({
      code: "EXECUTION_NOT_FOUND",
    });
  });

  it("4. a non-'queued' execution cannot be enqueued", async () => {
    const created = await createQueued();
    await repo.claimQueuedExecution(created.id); // now "running"

    await expect(queue.enqueueExecution(created.id)).rejects.toMatchObject({
      code: "EXECUTION_NOT_QUEUEABLE",
    });
  });

  it("5. enqueuing the same executionId twice (while still queued) never creates a second execution", async () => {
    const created = await createQueued();

    await queue.enqueueExecution(created.id);
    await queue.enqueueExecution(created.id);

    const rows = await db
      .select({ id: schema.executions.id })
      .from(schema.executions)
      .where(eq(schema.executions.workflowId, workflowA));
    const matching = rows.filter((r) => r.id === created.id);
    expect(matching).toHaveLength(1);
  });

  it("enqueueExecution never changes the execution's status itself", async () => {
    const created = await createQueued();
    await queue.enqueueExecution(created.id);

    const stillQueued = await repo.getExecutionById(userA, workspaceA, created.id);
    expect(stillQueued?.execution.status).toBe("queued");
  });

  it("6. two concurrent consumers never claim the same execution", async () => {
    const a = await createQueued();
    const b = await createQueued();

    const [claim1, claim2] = await Promise.all([
      queue.claimNextQueuedExecution(),
      queue.claimNextQueuedExecution(),
    ]);

    expect(claim1).not.toBeNull();
    expect(claim2).not.toBeNull();
    expect(claim1!.id).not.toBe(claim2!.id);
    expect([claim1!.id, claim2!.id].sort()).toEqual([a.id, b.id].sort());
  });

  it("claimNextQueuedExecution returns null when there is nothing queued", async () => {
    // Drain anything left queued from earlier tests in this file.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const claimed = await queue.claimNextQueuedExecution();
      if (!claimed) break;
    }
    const result = await queue.claimNextQueuedExecution();
    expect(result).toBeNull();
  });

  it("claimNextQueuedExecution actually transitions the row to running", async () => {
    const created = await createQueued();
    const claimed = await queue.claimNextQueuedExecution();
    expect(claimed!.id).toBe(created.id);
    expect(claimed!.status).toBe("running");
    expect(claimed!.claimAttempts).toBe(1);
  });

  it("7. the job never carries workspaceId or document", async () => {
    const created = await createQueued();
    const job = await queue.enqueueExecution(created.id);
    expect("workspaceId" in job).toBe(false);
    expect("document" in job).toBe(false);
    expect("userId" in job).toBe(false);
  });
});
