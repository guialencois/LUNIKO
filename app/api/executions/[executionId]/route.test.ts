import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Same approach as the execute route's test: mock every boundary so this
// exercises the route's own control flow and the response shape, not
// Supabase or Drizzle.
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/auth/actions", () => ({ ensureDefaultWorkspace: vi.fn() }));
vi.mock("@/server/execution/execution-repository", () => ({ getExecutionById: vi.fn() }));

import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultWorkspace } from "@/lib/auth/actions";
import { getExecutionById } from "@/server/execution/execution-repository";
import { GET } from "./route";

const mockGetCurrentUser = vi.mocked(getCurrentUser);
const mockEnsureDefaultWorkspace = vi.mocked(ensureDefaultWorkspace);
const mockGetExecutionById = vi.mocked(getExecutionById);

const ROUTE_PARAMS = { params: { executionId: "exec-1" } };

function makeRequest() {
  return new NextRequest("http://localhost/api/executions/exec-1", { method: "GET" });
}

/** A full row, including every field the response must NOT contain. */
function executionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "exec-1",
    workflowId: "wf-1",
    workspaceId: "ws-1",
    status: "queued",
    document: {
      schemaVersion: 1,
      nodes: [
        {
          id: "h",
          type: "httpRequest",
          name: "h",
          position: { x: 0, y: 0 },
          data: { headers: { Authorization: "Bearer sk-live-SECRET" } },
        },
      ],
      edges: [],
      settings: {},
    },
    triggerType: "manual",
    result: null,
    error: null,
    runner: "worker",
    claimAttempts: 2,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    createdBy: "user-1",
    createdAt: new Date("2026-09-20T12:00:00.000Z"),
    ...overrides,
  };
}

function authenticate() {
  mockGetCurrentUser.mockResolvedValue({ id: "user-1", email: "a@b.com" } as never);
  mockEnsureDefaultWorkspace.mockResolvedValue("ws-1");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/executions/[executionId]", () => {
  it("10a. rejects an unauthenticated request with 401 and never reads", async () => {
    mockGetCurrentUser.mockResolvedValue(null as never);

    const response = await GET(makeRequest(), ROUTE_PARAMS);

    expect(response.status).toBe(401);
    expect(mockGetExecutionById).not.toHaveBeenCalled();
  });

  it("10b. resolves the workspace server-side and never from the request", async () => {
    authenticate();
    mockGetExecutionById.mockResolvedValue({ execution: executionRow(), nodes: [] } as never);

    await GET(makeRequest(), ROUTE_PARAMS);

    expect(mockGetExecutionById).toHaveBeenCalledWith("user-1", "ws-1", "exec-1");
  });

  it("10c. a non-member gets the same 404 as a nonexistent execution", async () => {
    authenticate();
    // requireWorkspaceMembership throws for a non-member.
    mockGetExecutionById.mockRejectedValue(new Error("Not a member of this workspace"));

    const response = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error.code).toBe("EXECUTION_NOT_FOUND");
    // Nothing distinguishes it from the missing case:
    mockGetExecutionById.mockResolvedValue(null as never);
    const missing = await GET(makeRequest(), ROUTE_PARAMS);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("EXECUTION_NOT_FOUND");
  });

  it("11. returns a queued execution with null timestamps, no result, no error", async () => {
    authenticate();
    mockGetExecutionById.mockResolvedValue({ execution: executionRow(), nodes: [] } as never);

    const json = await (await GET(makeRequest(), ROUTE_PARAMS)).json();

    expect(json.status).toBe("queued");
    expect(json.executionId).toBe("exec-1");
    expect(json.startedAt).toBeNull();
    expect(json.finishedAt).toBeNull();
    expect(json.result).toBeUndefined();
    expect(json.error).toBeUndefined();
  });

  it("12. returns a running execution with startedAt and no finishedAt", async () => {
    authenticate();
    mockGetExecutionById.mockResolvedValue({
      execution: executionRow({ status: "running", startedAt: new Date("2026-09-20T12:00:05.000Z") }),
      nodes: [],
    } as never);

    const json = await (await GET(makeRequest(), ROUTE_PARAMS)).json();

    expect(json.status).toBe("running");
    expect(json.startedAt).toBe("2026-09-20T12:00:05.000Z");
    expect(json.finishedAt).toBeNull();
  });

  it("13. returns a successful execution with its result and node rows", async () => {
    authenticate();
    mockGetExecutionById.mockResolvedValue({
      execution: executionRow({
        status: "success",
        result: { items: [{ json: { bookingKey: "LEN-2026-0417" } }] },
        startedAt: new Date("2026-09-20T12:00:05.000Z"),
        finishedAt: new Date("2026-09-20T12:00:06.000Z"),
        durationMs: 1000,
      }),
      nodes: [
        {
          id: "n1",
          executionId: "exec-1",
          nodeId: "s",
          nodeType: "set",
          status: "success",
          input: null,
          output: { items: [{ json: { bookingKey: "LEN-2026-0417" } }] },
          error: null,
          durationMs: 3,
          startedAt: new Date("2026-09-20T12:00:05.000Z"),
          finishedAt: new Date("2026-09-20T12:00:05.003Z"),
        },
      ],
    } as never);

    const json = await (await GET(makeRequest(), ROUTE_PARAMS)).json();

    expect(json.status).toBe("success");
    expect(json.result).toEqual({ items: [{ json: { bookingKey: "LEN-2026-0417" } }] });
    expect(json.durationMs).toBe(1000);
    expect(json.nodes).toHaveLength(1);
    expect(json.nodes[0].nodeId).toBe("s");
    // Per-node payloads stay out: the endpoint is polled, and `result`
    // already carries the final output.
    expect(json.nodes[0].output).toBeUndefined();
    expect(json.nodes[0].input).toBeUndefined();
  });

  it("14. returns a failed execution with its error and no result", async () => {
    authenticate();
    mockGetExecutionById.mockResolvedValue({
      execution: executionRow({
        status: "error",
        error: { code: "WORKER_CRASHED", message: "abandoned", nodeId: "s" },
        finishedAt: new Date("2026-09-20T12:00:09.000Z"),
      }),
      nodes: [],
    } as never);

    const json = await (await GET(makeRequest(), ROUTE_PARAMS)).json();

    expect(json.status).toBe("error");
    expect(json.error).toEqual({ code: "WORKER_CRASHED", message: "abandoned", nodeId: "s" });
    expect(json.result).toBeUndefined();
  });

  it("15+16+17. never exposes runner, claimAttempts, the document, or anything in it", async () => {
    authenticate();
    mockGetExecutionById.mockResolvedValue({ execution: executionRow(), nodes: [] } as never);

    const response = await GET(makeRequest(), ROUTE_PARAMS);
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(json.runner).toBeUndefined();
    expect(json.claimAttempts).toBeUndefined();
    expect(json.document).toBeUndefined();
    expect(json.workspaceId).toBeUndefined();
    expect(json.createdBy).toBeUndefined();

    // And nothing leaks by another name: the row carried a real credential
    // in its document, and none of it appears anywhere in the payload.
    expect(serialized).not.toContain("sk-live-SECRET");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("claimAttempts");
    expect(serialized).not.toContain("runner");
  });
});
