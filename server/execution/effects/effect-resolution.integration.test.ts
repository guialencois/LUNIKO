import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

/**
 * Integration tests for Fase 10.5A — what a person may do with an "unknown"
 * external operation (resolution.ts), through the REAL repository against
 * PostgreSQL, with the FAKE provider. Nothing here sends anything.
 *
 * Requires TEST_DATABASE_URL with migrations 0000-0007 applied; skipped,
 * not faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 *
 * The same rules run today, against real PostgreSQL, in
 * scripts/f4f-lifecycle-harness.sql (section 9) and, for the two-session
 * races (two people; a person vs the provider's late answer),
 * scripts/concurrency-check.sh (scenarios 8 and 9).
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("resolving unknown external operations (Fase 10.5A, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("../execution-repository");
  let effects: typeof import("./effect-repository");
  let runnerModule: typeof import("./effect-runner");
  let mock: typeof import("./test-support/mock-external-effect");
  let resolution: typeof import("./resolution");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let workspaceB: string;
  let owner: string;
  let admin: string;
  let member: string;
  let ownerB: string;
  let workflowA: string;

  const NO_COOLING = { coolingPeriodSeconds: 0 };
  const emptyDoc = { schemaVersion: 1, nodes: [], edges: [], settings: { executionMode: "default" } };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("../execution-repository");
    effects = await import("./effect-repository");
    runnerModule = await import("./effect-runner");
    mock = await import("./test-support/mock-external-effect");
    resolution = await import("./resolution");
    workflowMutations = await import("@/server/workflows/mutations");

    [owner, admin, member, ownerB] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const [wsA] = await db.insert(schema.workspaces).values({ name: "10.5A resolution A" }).returning({ id: schema.workspaces.id });
    const [wsB] = await db.insert(schema.workspaces).values({ name: "10.5A resolution B" }).returning({ id: schema.workspaces.id });
    workspaceA = wsA!.id;
    workspaceB = wsB!.id;
    await db.insert(schema.workspaceMembers).values([
      { workspaceId: workspaceA, userId: owner, role: "owner" },
      { workspaceId: workspaceA, userId: admin, role: "admin" },
      { workspaceId: workspaceA, userId: member, role: "member" },
      { workspaceId: workspaceB, userId: ownerB, role: "owner" },
    ]);
    const workflow = await workflowMutations.createWorkflow(owner, workspaceA, { name: "10.5A", description: "" });
    workflowA = workflow!.id;
  });

  afterAll(async () => {
    if (!hasTestDb) return;
    const ops = await db
      .select({ id: schema.effectOperations.id })
      .from(schema.effectOperations)
      .where(eq(schema.effectOperations.workspaceId, workspaceA));
    if (ops.length > 0) {
      await db.delete(schema.effectAttempts).where(inArray(schema.effectAttempts.operationId, ops.map((o) => o.id)));
      await db.delete(schema.effectOperations).where(eq(schema.effectOperations.workspaceId, workspaceA));
    }
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [workspaceA, workspaceB]));
  });

  // ---- helpers ---------------------------------------------------------

  const notSent = () =>
    resolution.validateResolveEffectRequest({
      resolution: "confirmed_not_sent",
      evidence: { source: "provider_dashboard", detail: "no message to lead-42 in the dashboard" },
      justification: "checked the provider dashboard; nothing was sent",
    });
  const sent = (providerReference: string) =>
    resolution.validateResolveEffectRequest({
      resolution: "confirmed_sent",
      providerReference,
      evidence: { source: "provider_api" },
      justification: "the provider API lists it as delivered",
    });

  /** An operation whose call timed out (unknown); `end` finishes the execution. */
  async function unknownOperation(options: { end?: boolean } = {}) {
    const created = await repo.createQueuedExecution(owner, workspaceA, workflowA, emptyDoc);
    const claimed = await repo.claimQueuedExecution(created.id);
    const epoch = claimed!.claimAttempts;
    const provider = new mock.MockExternalEffect();
    const result = await runnerModule
      .createEffectRunner({ executionId: created.id, workspaceId: workspaceA, epoch })
      .run("send", { operation: "mock.send_message", businessKey: "lead-42", payload: { text: "Olá" }, perform: provider.perform("timeout") });
    expect(result.status).toBe("unknown");
    if (options.end !== false) {
      await repo.finishQueuedExecution(created.id, {
        status: "error", durationMs: 1, error: { code: "EXTERNAL_EFFECT_UNKNOWN", message: "unknown" }, expectedClaimAttempts: epoch,
      });
    }
    const [op] = await db.select().from(schema.effectOperations).where(eq(schema.effectOperations.executionId, created.id));
    return { op: op!, executionId: created.id, epoch };
  }

  async function historyOf(operationId: string) {
    return db.select().from(schema.effectAttempts).where(eq(schema.effectAttempts.operationId, operationId)).orderBy(schema.effectAttempts.seq);
  }

  // ---- reading -------------------------------------------------------------

  it("lists the unknown operations of the caller's workspace only, with workflow and began time", async () => {
    const { op } = await unknownOperation();
    const mine = await effects.listEffectOperations(member, workspaceA); // any member reads
    const row = mine.find((r) => r.op.id === op.id);
    expect(row).toMatchObject({ workflowId: workflowA, workflowName: "10.5A", executionStatus: "error" });
    expect(row!.beganAt).toBeInstanceOf(Date);
    const theirs = await effects.listEffectOperations(ownerB, workspaceB);
    expect(theirs.map((r) => r.op.id)).not.toContain(op.id);
    const detail = await effects.getEffectOperationDetail(member, workspaceA, op.id);
    expect(detail!.attempts.map((a) => a.event)).toEqual(["reserved", "began", "unknown"]);
  });

  // ---- who and when ----------------------------------------------------------

  it("only owner/admin decide; another workspace cannot even find it", async () => {
    const { op } = await unknownOperation();
    expect(await effects.resolveUnknownEffectOperation(member, workspaceA, op.id, notSent(), NO_COOLING)).toEqual({ outcome: "forbidden" });
    expect(await effects.resolveUnknownEffectOperation(ownerB, workspaceB, op.id, notSent(), NO_COOLING)).toEqual({ outcome: "not_found" });
    expect((await effects.resolveUnknownEffectOperation(admin, workspaceA, op.id, notSent(), NO_COOLING)).outcome).toBe("resolved");
  });

  it("not while the execution may still act, nor inside the cooling period (database clock)", async () => {
    const { op, executionId, epoch } = await unknownOperation({ end: false });
    expect(await effects.resolveUnknownEffectOperation(owner, workspaceA, op.id, notSent(), NO_COOLING)).toEqual({
      outcome: "execution_active",
      executionStatus: "running",
    });
    await repo.finishQueuedExecution(executionId, { status: "error", durationMs: 1, expectedClaimAttempts: epoch });
    const early = await effects.resolveUnknownEffectOperation(owner, workspaceA, op.id, notSent());
    expect(early.outcome).toBe("too_early");
    const began = (await historyOf(op.id)).find((a) => a.event === "began")!.createdAt;
    if (early.outcome === "too_early") {
      expect(early.resolvableFrom.getTime()).toBe(began.getTime() + resolution.RESOLUTION_COOLING_PERIOD_SECONDS * 1000);
    }
    // refusals leave no trace
    expect((await historyOf(op.id)).map((a) => a.event)).toEqual(["reserved", "began", "unknown"]);
  });

  // ---- what is written ---------------------------------------------------------

  it("records the decision, who made it, and ONE resolved fact with evidence and justification", async () => {
    const { op } = await unknownOperation();
    const result = await effects.resolveUnknownEffectOperation(owner, workspaceA, op.id, notSent(), NO_COOLING);
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.operation).toMatchObject({
      status: "failed",
      resolution: "confirmed_not_sent",
      resolvedByUserId: owner,
      providerReference: null,
      lastError: { code: "RESOLVED_NOT_SENT", message: "checked the provider dashboard; nothing was sent" },
    });
    const facts = (await historyOf(op.id)).filter((a) => a.event === "resolved");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      actor: "user", epoch: null, actorUserId: owner, fromStatus: "unknown", toStatus: "failed", applied: true,
      detail: {
        resolution: "confirmed_not_sent",
        evidence: { source: "provider_dashboard", detail: "no message to lead-42 in the dashboard" },
        justification: "checked the provider dashboard; nothing was sent",
      },
    });
  });

  it("confirmed_sent carries the provider's reference; nobody resolves twice", async () => {
    const { op } = await unknownOperation();
    const first = await effects.resolveUnknownEffectOperation(owner, workspaceA, op.id, sent("prov-123"), NO_COOLING);
    expect(first.outcome === "resolved" && first.operation).toMatchObject({ status: "succeeded", providerReference: "prov-123", resolution: "confirmed_sent" });
    expect(await effects.resolveUnknownEffectOperation(admin, workspaceA, op.id, notSent(), NO_COOLING)).toEqual({
      outcome: "not_unknown",
      status: "succeeded",
    });
  });

  it("the database refuses a resolved fact without evidence, whatever wrote it (0007)", async () => {
    const { op } = await unknownOperation();
    await expect(
      db.insert(schema.effectAttempts).values({
        operationId: op.id, event: "resolved", actor: "user", actorUserId: owner,
        fromStatus: "unknown", toStatus: "failed", applied: true,
        detail: { resolution: "confirmed_not_sent", evidence: { source: "provider_dashboard", detail: "nothing" } }, // no justification
      })
    ).rejects.toThrow(/effect_attempts_resolution_has_evidence/);
    // a MISSING key must not slip through as NULL (CHECK passes on NULL)
    await expect(
      db.insert(schema.effectAttempts).values({
        operationId: op.id, event: "resolved", actor: "user", actorUserId: owner,
        fromStatus: "unknown", toStatus: "failed", applied: true,
        detail: { justification: "0123456789", evidence: { detail: "abcde" } }, // no resolution, no source
      })
    ).rejects.toThrow(/effect_attempts_resolution_has_evidence/);
  });

  it("the database ties a resolution to its record: no state change without the resolved fact (0007, 6)", async () => {
    const { op } = await unknownOperation();
    // A direct write that marks it resolved but records nothing: refused at COMMIT (deferred trigger).
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(schema.effectOperations)
          .set({
            status: "failed",
            resolvedByUserId: owner,
            resolution: "confirmed_not_sent",
            lastError: { code: "RESOLVED_NOT_SENT", message: "x" },
          })
          .where(eq(schema.effectOperations.id, op.id));
      })
    ).rejects.toSatisfy((err: unknown) => /must be recorded/.test(String((err as Error).message ?? err)));
    const [after] = await db.select().from(schema.effectOperations).where(eq(schema.effectOperations.id, op.id));
    expect(after).toMatchObject({ status: "unknown", resolution: null, resolvedByUserId: null });
  });

  // ---- the provider's word outranks a person's --------------------------------

  it("a later answer from the provider replaces a conflicting resolution, and history keeps both", async () => {
    const created = await repo.createQueuedExecution(owner, workspaceA, workflowA, emptyDoc);
    const epoch = (await repo.claimQueuedExecution(created.id))!.claimAttempts;
    const provider = new mock.MockExternalEffect();
    let wake!: () => void;
    const gate = new Promise<void>((r) => { wake = r; });
    // the call crosses the point of no return and stalls
    const pending = runnerModule.createEffectRunner({ executionId: created.id, workspaceId: workspaceA, epoch }).run("send", {
      operation: "mock.send_message", businessKey: "lead-42", payload: { text: "Olá" },
      perform: async (key) => { await gate; return provider.perform("success")(key); },
    });
    for (let i = 0; i < 100; i++) {
      const [op] = await db.select().from(schema.effectOperations).where(eq(schema.effectOperations.executionId, created.id));
      if (op?.status === "in_flight") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await repo.finishQueuedExecution(created.id, { status: "error", durationMs: 1, expectedClaimAttempts: epoch }); // -> unknown (trigger)
    const [op] = await db.select().from(schema.effectOperations).where(eq(schema.effectOperations.executionId, created.id));
    expect(op!.status).toBe("unknown");

    expect((await effects.resolveUnknownEffectOperation(owner, workspaceA, op!.id, notSent(), NO_COOLING)).outcome).toBe("resolved");
    wake();
    expect((await pending).status).toBe("succeeded");

    const [after] = await db.select().from(schema.effectOperations).where(eq(schema.effectOperations.id, op!.id));
    expect(after).toMatchObject({ status: "succeeded", providerReference: "mock-msg-1", resolvedByUserId: null, resolution: null });
    const history = await historyOf(op!.id);
    expect(history.map((a) => `${a.event}@${a.actor}`)).toEqual([
      "reserved@worker", "began@worker", "unknown@system", "resolved@user", "succeeded@worker",
    ]);
    expect(history.at(-1)!.detail).toMatchObject({
      overridesResolution: { status: "failed", resolution: "confirmed_not_sent", resolvedByUserId: owner },
    });
  });
});
