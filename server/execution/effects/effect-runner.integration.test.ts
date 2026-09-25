import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

/**
 * Integration tests for Fase 10 — the durable record of external operations,
 * driven through the REAL runner and the REAL repository against PostgreSQL,
 * with a FAKE provider (test-support/mock-external-effect.ts). Nothing here
 * sends a message, charges money, or touches an external account.
 *
 * Same rationale as every other *.integration.test.ts: the guarantees live
 * in row locks and conditional writes, which a mock cannot exercise.
 * Requires TEST_DATABASE_URL with migrations 0000-0007 applied; skipped, not
 * faked, otherwise.
 *
 *   TEST_DATABASE_URL=postgres://... npm test
 *
 * Cleanup deletes effect_attempts and effect_operations explicitly before
 * the workspace: those tables reference executions/workspaces with
 * ON DELETE RESTRICT, on purpose (evidence of an external effect is never
 * deleted as a side effect of deleting something else).
 */
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("external effects (Fase 10, integration)", () => {
  let db: typeof import("@/lib/db").db;
  let schema: typeof import("@/lib/db/schema");
  let repo: typeof import("../execution-repository");
  let effects: typeof import("./effect-repository");
  let runnerModule: typeof import("./effect-runner");
  let keys: typeof import("./effect-key");
  let mock: typeof import("./test-support/mock-external-effect");
  let workflowMutations: typeof import("@/server/workflows/mutations");

  let workspaceA: string;
  let userA: string;
  let workflowA: string;

  const OPERATION = "mock.send_message";
  const emptyDoc = {
    schemaVersion: 1,
    nodes: [],
    edges: [],
    settings: { executionMode: "default" },
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    db = (await import("@/lib/db")).db;
    schema = await import("@/lib/db/schema");
    repo = await import("../execution-repository");
    effects = await import("./effect-repository");
    runnerModule = await import("./effect-runner");
    keys = await import("./effect-key");
    mock = await import("./test-support/mock-external-effect");
    workflowMutations = await import("@/server/workflows/mutations");

    userA = crypto.randomUUID();
    const [wsA] = await db
      .insert(schema.workspaces)
      .values({ name: "Fase 10 Test Workspace" })
      .returning({ id: schema.workspaces.id });
    workspaceA = wsA!.id;
    await db.insert(schema.workspaceMembers).values({ workspaceId: workspaceA, userId: userA, role: "owner" });
    const workflow = await workflowMutations.createWorkflow(userA, workspaceA, {
      name: "Fase 10 test workflow",
      description: "",
    });
    workflowA = workflow.id;
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
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceA));
  });

  // ---- helpers ---------------------------------------------------------

  async function claimedExecution() {
    const created = await repo.createQueuedExecution(userA, workspaceA, workflowA, emptyDoc);
    const claimed = await repo.claimQueuedExecution(created.id);
    return { executionId: created.id, epoch: claimed!.claimAttempts };
  }

  /** The worker died; its lease expired; the reaper returns it to the queue
   *  and the next worker claims it. Returns the new epoch. */
  async function reclaimAndClaim(executionId: string) {
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, executionId));
    const reclaimed = await repo.reclaimExpiredExecution(executionId);
    expect(reclaimed).not.toBeNull();
    const claimed = await repo.claimQueuedExecution(executionId);
    return claimed!.claimAttempts;
  }

  function runnerFor(executionId: string, epoch: number) {
    return runnerModule.createEffectRunner({ executionId, workspaceId: workspaceA, epoch });
  }

  function spec(
    provider: InstanceType<typeof mock.MockExternalEffect>,
    behavior: import("./test-support/mock-external-effect").MockBehavior,
    overrides: { businessKey?: string; payload?: Record<string, unknown> } = {}
  ) {
    const businessKey = overrides.businessKey ?? "lead-42";
    return {
      operation: OPERATION,
      businessKey,
      payload: overrides.payload ?? { text: "Olá", recipient: businessKey },
      perform: provider.perform(behavior),
    };
  }

  async function operationsOf(executionId: string) {
    return db.select().from(schema.effectOperations).where(eq(schema.effectOperations.executionId, executionId));
  }

  async function eventsOf(operationId: string) {
    const rows = await db
      .select()
      .from(schema.effectAttempts)
      .where(eq(schema.effectAttempts.operationId, operationId))
      .orderBy(schema.effectAttempts.seq);
    return rows.map((a) => `${a.event}@${a.actor === "worker" ? a.epoch : a.actor}`).join(" ");
  }

  /** Fase 10.5A: a person may only decide with evidence and a
   *  justification. These tests are about the runner, so the cooling period
   *  is waived (0 s); effect-resolution.integration.test.ts tests it. */
  const NO_COOLING = { coolingPeriodSeconds: 0 };
  function confirmedSent(providerReference: string) {
    return {
      resolution: "confirmed_sent" as const,
      providerReference,
      evidence: { source: "provider_dashboard" as const, detail: "message listed as delivered" },
      justification: "found the message in the provider dashboard",
    };
  }
  function confirmedNotSent() {
    return {
      resolution: "confirmed_not_sent" as const,
      evidence: { source: "provider_dashboard" as const, detail: "no message to lead-42 in the dashboard" },
      justification: "checked the provider dashboard; nothing was sent",
    };
  }

  /** Waits until a background attempt has reached its crash point, judged
   *  by the durable record rather than by a fixed sleep. */
  async function waitForStatus(executionId: string, status: string) {
    for (let i = 0; i < 100; i++) {
      const [op] = await operationsOf(executionId);
      if (op?.status === status) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`operation never reached "${status}"`);
  }

  // ---- the seven MockExternalEffect scenarios ---------------------------

  it("success: one accepted request, recorded with the provider reference", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    const result = await runnerFor(executionId, epoch).run("send", spec(provider, "success"));

    expect(result).toEqual({ status: "succeeded", providerReference: "mock-msg-1", replayed: false });
    const op = (await operationsOf(executionId))[0]!;
    expect(op.status).toBe("succeeded");
    expect(provider.acceptedFor(op.idempotencyKey)).toBe(1);
    expect(await eventsOf(op.id)).toBe("reserved@1 began@1 succeeded@1");
  });

  it("failure: definitive rejection, nothing accepted, never retried", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    const first = await runnerFor(executionId, epoch).run("send", spec(provider, "failure"));
    const epoch2 = await reclaimAndClaim(executionId);
    const second = await runnerFor(executionId, epoch2).run("send", spec(provider, "success"));

    expect(first).toMatchObject({ status: "failed", code: "MOCK_REJECTED", replayed: false });
    expect(second).toMatchObject({ status: "failed", replayed: true });
    expect(provider.ledger).toHaveLength(0);
    expect(provider.calls).toBe(1);
  });

  it("timeout: unknown, permanent across epochs, left only by explicit resolution", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    const first = await runnerFor(executionId, epoch).run("send", spec(provider, "timeout"));
    const epoch2 = await reclaimAndClaim(executionId);
    const second = await runnerFor(executionId, epoch2).run("send", spec(provider, "success"));

    expect(first.status).toBe("unknown");
    expect(second.status).toBe("unknown");
    expect(provider.calls).toBe(1);
    const op = (await operationsOf(executionId))[0]!;
    expect(op.status).toBe("unknown");

    // Nobody decides while the execution may still act on its behalf...
    expect(
      await effects.resolveUnknownEffectOperation(userA, workspaceA, op.id, confirmedSent("mock-msg-1"), NO_COOLING)
    ).toEqual({ outcome: "execution_active", executionStatus: "running" });
    await repo.finishQueuedExecution(executionId, {
      status: "error",
      durationMs: 1,
      error: { code: "TEST_ENDED", message: "ended by the test" },
      expectedClaimAttempts: epoch2,
    });
    // ...nor inside the cooling period (the call itself may still answer).
    const early = await effects.resolveUnknownEffectOperation(userA, workspaceA, op.id, confirmedSent("mock-msg-1"));
    expect(early.outcome).toBe("too_early");

    const resolved = await effects.resolveUnknownEffectOperation(
      userA,
      workspaceA,
      op.id,
      confirmedSent("mock-msg-1"),
      NO_COOLING
    );
    expect(resolved.outcome).toBe("resolved");
    expect((await operationsOf(executionId))[0]).toMatchObject({
      status: "succeeded",
      providerReference: "mock-msg-1",
      resolvedByUserId: userA,
      resolution: "confirmed_sent",
    });
    expect(await eventsOf(op.id)).toContain("resolved@user");
  });

  it("crash-before-request (after begin committed): the next epoch does NOT send — unknown", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    void runnerFor(executionId, epoch).run("send", spec(provider, "crash_before_request"));
    await waitForStatus(executionId, "in_flight");
    const epoch2 = await reclaimAndClaim(executionId);
    const result = await runnerFor(executionId, epoch2).run("send", spec(provider, "success"));

    expect(result.status).toBe("unknown");
    expect(provider.ledger).toHaveLength(0);
    const op = (await operationsOf(executionId))[0]!;
    expect(op).toMatchObject({ status: "unknown", ownerEpoch: epoch2, beganEpoch: epoch });
  });

  it("crash-after-request: the provider accepted; the next epoch does NOT send again", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    void runnerFor(executionId, epoch).run("send", spec(provider, "crash_after_request"));
    await waitForStatus(executionId, "in_flight");
    const epoch2 = await reclaimAndClaim(executionId);
    const result = await runnerFor(executionId, epoch2).run("send", spec(provider, "success"));

    expect(result.status).toBe("unknown");
    expect(provider.ledger).toHaveLength(1);
    expect((await operationsOf(executionId))[0]!.status).toBe("unknown");
  });

  it("late-success: a superseded epoch's confirmation is recorded by authorship", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    const late = runnerFor(executionId, epoch).run("send", spec(provider, "late_success"));
    await waitForStatus(executionId, "in_flight");
    const epoch2 = await reclaimAndClaim(executionId);
    expect((await runnerFor(executionId, epoch2).run("send", spec(provider, "success"))).status).toBe("unknown");

    provider.releaseLate();
    expect((await late).status).toBe("succeeded");
    const op = (await operationsOf(executionId))[0]!;
    expect(op).toMatchObject({ status: "succeeded", providerReference: "mock-msg-1", ownerEpoch: epoch2 });
    expect(provider.ledger).toHaveLength(1);
    // and the superseded epoch still cannot finish the execution
    const finished = await repo.finishQueuedExecution(executionId, {
      status: "success",
      durationMs: 1,
      expectedClaimAttempts: epoch,
    });
    expect(finished).toBeNull();
  });

  it("duplicate-attempt: same epoch (sequential and concurrent) and zombie + owner send once", async () => {
    const provider = new mock.MockExternalEffect();
    const a = await claimedExecution();
    const runner = runnerFor(a.executionId, a.epoch);
    await runner.run("send", spec(provider, "success"));
    const replay = await runner.run("send", spec(provider, "success"));
    const concurrent = await Promise.all([
      runner.run("send-2", spec(provider, "success")),
      runner.run("send-2", spec(provider, "success")),
    ]);
    expect(replay).toMatchObject({ status: "succeeded", replayed: true });
    // the second concurrent run shares the first attempt (coalesced in the
    // runner): one real send, one replay — never a spurious "unknown"
    expect(concurrent.map((r) => (r.status === "succeeded" ? r.replayed : r.status)).sort()).toEqual([false, true]);
    expect(provider.ledger).toHaveLength(2); // one per logical operation
    expect(await operationsOf(a.executionId)).toHaveLength(2);

    // zombie that never reserved: fenced at reserve, nothing created
    const b = await claimedExecution();
    await reclaimAndClaim(b.executionId);
    const zombie = await runnerFor(b.executionId, b.epoch).run("send", spec(provider, "success"));
    expect(zombie.status).toBe("fenced");
    expect(await operationsOf(b.executionId)).toHaveLength(0);
  });

  // ---- A-K ---------------------------------------------------------------

  it("A/B/D/H: one operation per identity across attempts and epochs; the key never changes", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    // epoch 1 reserves and dies before crossing the point of no return
    const reserved = await effects.reserveEffectOperation({
      executionId,
      workspaceId: workspaceA,
      nodeId: "send",
      businessKey: "lead-42",
      operation: OPERATION,
      idempotencyKey: keys.deriveIdempotencyKey({ executionId, nodeId: "send", businessKey: "lead-42", operation: OPERATION }),
      payloadFingerprint: keys.fingerprintPayload({ text: "Olá", recipient: "lead-42" }),
      epoch,
    });
    expect(reserved.outcome).toBe("reserved");
    const before = (await operationsOf(executionId))[0]!;

    const epoch2 = await reclaimAndClaim(executionId);
    const result = await runnerFor(executionId, epoch2).run("send", spec(provider, "success"));
    const ops = await operationsOf(executionId);

    expect(result).toMatchObject({ status: "succeeded", replayed: false });
    expect(ops).toHaveLength(1); // B
    expect(ops[0]!.id).toBe(before.id); // H
    expect(ops[0]!.idempotencyKey).toBe(before.idempotencyKey); // H
    expect(provider.ledger[0]!.idempotencyKey).toBe(before.idempotencyKey); // D
    expect(await eventsOf(before.id)).toBe(`reserved@${epoch} adopted@${epoch2} began@${epoch2} succeeded@${epoch2}`);
  });

  it("C: two concurrent reservations of the same identity create one operation", async () => {
    const { executionId, epoch } = await claimedExecution();
    const input = {
      executionId,
      workspaceId: workspaceA,
      nodeId: "send",
      businessKey: "lead-42",
      operation: OPERATION,
      idempotencyKey: keys.deriveIdempotencyKey({ executionId, nodeId: "send", businessKey: "lead-42", operation: OPERATION }),
      payloadFingerprint: "fp",
      epoch,
    };
    // NOTE: lib/db uses max: 1, so these two share one connection and are
    // serialized by the client. The two-SESSION race is exercised in
    // scripts/concurrency-check.sh, scenario 6 — this only proves the
    // outcome shape under the application's own concurrency.
    const results = await Promise.all([effects.reserveEffectOperation(input), effects.reserveEffectOperation(input)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["exists", "reserved"]);
    expect(await operationsOf(executionId)).toHaveLength(1);
  });

  it("E/F/G: different node, business key or execution never collide", async () => {
    const provider = new mock.MockExternalEffect();
    const a = await claimedExecution();
    const b = await claimedExecution();
    await runnerFor(a.executionId, a.epoch).run("send-a", spec(provider, "success"));
    await runnerFor(a.executionId, a.epoch).run("send-b", spec(provider, "success"));
    await runnerFor(a.executionId, a.epoch).run("send-a", spec(provider, "success", { businessKey: "lead-43" }));
    await runnerFor(b.executionId, b.epoch).run("send-a", spec(provider, "success"));

    const all = [...(await operationsOf(a.executionId)), ...(await operationsOf(b.executionId))];
    expect(all).toHaveLength(4);
    expect(new Set(all.map((o) => o.idempotencyKey)).size).toBe(4);
    expect(provider.ledger).toHaveLength(4);
  });

  it("I: an old epoch cannot record a fact on a call the new epoch made", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    const key = keys.deriveIdempotencyKey({ executionId, nodeId: "send", businessKey: "lead-42", operation: OPERATION });
    await effects.reserveEffectOperation({
      executionId, workspaceId: workspaceA, nodeId: "send", businessKey: "lead-42",
      operation: OPERATION, idempotencyKey: key,
      payloadFingerprint: keys.fingerprintPayload({ text: "Olá", recipient: "lead-42" }), epoch,
    });
    const epoch2 = await reclaimAndClaim(executionId);
    const pending = runnerFor(executionId, epoch2).run("send", spec(provider, "late_success"));
    await waitForStatus(executionId, "in_flight");

    const op = (await operationsOf(executionId))[0]!;
    const forged = await effects.recordEffectOutcome({
      operationId: op.id,
      executionId,
      epoch,
      outcome: { kind: "succeeded", providerReference: "forged-by-epoch-1" },
    });
    expect(forged?.status).toBe("in_flight");
    expect(forged?.providerReference).toBeNull();

    provider.releaseLate();
    expect((await pending).status).toBe("succeeded");
    expect((await operationsOf(executionId))[0]!.providerReference).toBe("mock-msg-1");
  });

  it("J: an execution that ends with an operation in flight leaves it unknown (trigger)", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    void runnerFor(executionId, epoch).run("send", spec(provider, "crash_before_request"));
    await waitForStatus(executionId, "in_flight");
    expect((await operationsOf(executionId))[0]!.status).toBe("in_flight");

    await repo.finishQueuedExecution(executionId, {
      status: "error",
      durationMs: 1,
      expectedClaimAttempts: epoch,
    });
    const op = (await operationsOf(executionId))[0]!;
    expect(op.status).toBe("unknown");
    expect(await eventsOf(op.id)).toBe(`reserved@${epoch} began@${epoch} unknown@system`);
  });

  it("K: no payload, header or credential reaches the durable record", async () => {
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    const payload = {
      text: "Olá",
      authorization: "Bearer sk-live-SECRET123",
      apiKey: "sk-live-SECRET123",
      cookie: "session=abc123SECRET",
    };
    await runnerFor(executionId, epoch).run("send", spec(provider, "success", { payload }));
    const ops = await operationsOf(executionId);
    const attempts = await db
      .select()
      .from(schema.effectAttempts)
      .where(inArray(schema.effectAttempts.operationId, ops.map((o) => o.id)));
    const dump = JSON.stringify([ops, attempts]);
    expect(dump).not.toMatch(/SECRET|sk-live|Bearer|session=/);
    expect(ops[0]!.payloadFingerprint).toBe(keys.fingerprintPayload(payload));
  });

  it("a provider fact replaces a person's resolution made while the call was still pending", async () => {
    // Found by the independent review: the worker stalls between begin and
    // the call, the reaper abandons, a person resolves "failed", and then the
    // stalled worker sends. The record must end up saying what happened.
    const provider = new mock.MockExternalEffect();
    const { executionId, epoch } = await claimedExecution();
    let wake!: () => void;
    const gate = new Promise<void>((r) => (wake = r));
    const pending = runnerFor(executionId, epoch).run("send", {
      operation: OPERATION,
      businessKey: "lead-42",
      payload: { text: "Olá", recipient: "lead-42" },
      perform: async (key) => {
        await gate;
        return provider.perform("success")(key);
      },
    });
    await waitForStatus(executionId, "in_flight");
    await reclaimAndClaim(executionId);
    await reclaimAndClaim(executionId); // epoch 3 is the last attempt
    await db
      .update(schema.executions)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.executions.id, executionId));
    await repo.abandonExecution(executionId, { code: "WORKER_CRASHED", message: "lease expired" });
    const op = (await operationsOf(executionId))[0]!;
    expect(op.status).toBe("unknown"); // the terminal trigger

    const judged = await effects.resolveUnknownEffectOperation(userA, workspaceA, op.id, confirmedNotSent(), NO_COOLING);
    expect(judged.outcome).toBe("resolved");
    wake();
    expect((await pending).status).toBe("succeeded");
    const after = (await operationsOf(executionId))[0]!;
    expect(after).toMatchObject({
      status: "succeeded",
      providerReference: "mock-msg-1",
      resolvedByUserId: null,
      resolution: null,
    });
    expect(await eventsOf(op.id)).toBe(`reserved@${epoch} began@${epoch} unknown@system resolved@user succeeded@${epoch}`);
  });

  it("an exception's text is never stored (it can carry a token)", async () => {
    const { executionId, epoch } = await claimedExecution();
    const result = await runnerFor(executionId, epoch).run("send", {
      operation: OPERATION,
      businessKey: "lead-42",
      payload: { text: "Olá" },
      perform: async () => {
        throw new TypeError('Headers.append: "Bearer EAAG-SECRET-TOKEN\r\nx" is an invalid header value.');
      },
    });
    expect(result.status).toBe("unknown");
    const ops = await operationsOf(executionId);
    const attempts = await db
      .select()
      .from(schema.effectAttempts)
      .where(inArray(schema.effectAttempts.operationId, ops.map((o) => o.id)));
    expect(JSON.stringify([ops, attempts, result])).not.toMatch(/EAAG|SECRET|Bearer/);
  });

  it("effects are never available on the synchronous path", async () => {
    // execute-workflow.ts passes neither epoch nor effects; reserve itself
    // also refuses an execution whose runner is 'request'.
    const created = await repo.createExecution(userA, workspaceA, workflowA, emptyDoc);
    const reserved = await effects.reserveEffectOperation({
      executionId: created.id, workspaceId: workspaceA, nodeId: "send", businessKey: "lead-42",
      operation: OPERATION, idempotencyKey: "k-sync", payloadFingerprint: "fp", epoch: 0,
    });
    expect(reserved.outcome).toBe("fenced");
  });
});
