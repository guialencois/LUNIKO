import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useExecutionStore } from "./execution-store";
import { useWorkflowEditorStore } from "./workflow-editor-store";

function jsonResponse(body: unknown, status: number, ok: boolean) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  useExecutionStore.setState({
    status: "idle",
    executionId: null,
    result: null,
    error: null,
    isPanelOpen: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useExecutionStore — loading state", () => {
  it("sets status to running and opens the panel immediately on execute()", async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)))
    );

    const promise = useExecutionStore.getState().execute("wf-1");
    expect(useExecutionStore.getState().status).toBe("running");
    expect(useExecutionStore.getState().isPanelOpen).toBe(true);

    resolveFetch(jsonResponse({ executionId: "e1", status: "success", result: { items: [] } }, 200, true));
    await promise;
  });
});

describe("useExecutionStore — success", () => {
  it("stores executionId and result on a successful execution", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { executionId: "e1", status: "success", result: { items: [{ json: { ok: true } }] } },
          200,
          true
        )
      )
    );

    await useExecutionStore.getState().execute("wf-1");
    const state = useExecutionStore.getState();
    expect(state.status).toBe("success");
    expect(state.executionId).toBe("e1");
    expect(state.result).toEqual({ items: [{ json: { ok: true } }] });
    expect(state.error).toBeNull();
  });
});

describe("useExecutionStore — execution-domain error", () => {
  it("stores the error when the API responds 200 with status: 'error'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { executionId: "e1", status: "error", error: { code: "NOT_IMPLEMENTED", message: "nope", nodeId: "h1" } },
          200,
          true
        )
      )
    );

    await useExecutionStore.getState().execute("wf-1");
    const state = useExecutionStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toEqual({ code: "NOT_IMPLEMENTED", message: "nope", nodeId: "h1" });
  });

  it("stores status: 'cancelled' distinctly from 'error'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { executionId: "e1", status: "cancelled", error: { code: "EXECUTION_CANCELLED", message: "cancelled" } },
          200,
          true
        )
      )
    );

    await useExecutionStore.getState().execute("wf-1");
    expect(useExecutionStore.getState().status).toBe("cancelled");
  });
});

describe("useExecutionStore — HTTP-level failures", () => {
  it.each([
    [401, { error: { code: "UNAUTHENTICATED", message: "Not authenticated" } }],
    [400, { error: { code: "VALIDATION_ERROR", message: "Invalid body" } }],
    [404, { error: { code: "WORKFLOW_NOT_FOUND", message: "Not found" } }],
    [500, { error: { code: "EXECUTION_FAILED", message: "Unable to execute workflow. Please try again." } }],
  ])("handles HTTP %i without crashing and surfaces the error code", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, status, false)));

    await useExecutionStore.getState().execute("wf-1");
    const state = useExecutionStore.getState();
    expect(state.status).toBe("error");
    expect(state.error?.code).toBe((body as { error: { code: string } }).error.code);
  });

  it("handles a network failure (fetch rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await useExecutionStore.getState().execute("wf-1");
    const state = useExecutionStore.getState();
    expect(state.status).toBe("error");
    expect(state.error?.code).toBe("NETWORK_ERROR");
  });

  it("handles a response that isn't valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response)
    );

    await useExecutionStore.getState().execute("wf-1");
    expect(useExecutionStore.getState().error?.code).toBe("INVALID_RESPONSE");
  });

  it("handles a 200 response with an unexpected shape (missing status field)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ foo: "bar" }, 200, true)));

    await useExecutionStore.getState().execute("wf-1");
    expect(useExecutionStore.getState().error?.code).toBe("INVALID_RESPONSE");
  });
});

describe("useExecutionStore — reset for a new run", () => {
  it("clears the previous result/error as soon as a new execute() starts", async () => {
    useExecutionStore.setState({
      status: "error",
      executionId: "old",
      result: null,
      error: { code: "OLD_ERROR", message: "old" },
      isPanelOpen: true,
    });

    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)))
    );

    const promise = useExecutionStore.getState().execute("wf-1");
    // Immediately after calling execute(), old state must already be gone.
    expect(useExecutionStore.getState().error).toBeNull();
    expect(useExecutionStore.getState().executionId).toBeNull();
    expect(useExecutionStore.getState().status).toBe("running");

    resolveFetch(jsonResponse({ executionId: "new", status: "success", result: { items: [] } }, 200, true));
    await promise;
  });

  it("reset() returns the store to idle with everything cleared", () => {
    useExecutionStore.setState({
      status: "success",
      executionId: "e1",
      result: { items: [] },
      error: null,
      isPanelOpen: true,
    });

    useExecutionStore.getState().reset();

    expect(useExecutionStore.getState()).toMatchObject({
      status: "idle",
      executionId: null,
      result: null,
      error: null,
      isPanelOpen: false,
    });
  });
});

describe("useExecutionStore — isolation from the editor store", () => {
  it("never touches useWorkflowEditorStore, in either direction", async () => {
    const editorStateBefore = useWorkflowEditorStore.getState();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ executionId: "e1", status: "success", result: { items: [{ json: { x: 1 } }] } }, 200, true)
      )
    );

    await useExecutionStore.getState().execute("wf-1");

    // Same reference — execute() never called any editor-store setter.
    expect(useWorkflowEditorStore.getState()).toBe(editorStateBefore);
  });
});

describe("useExecutionStore — asynchronous path (4I)", () => {
  /** POST answers 202 queued, then each GET answers from this queue. */
  function stubAsyncFetch(pollBodies: unknown[]) {
    let poll = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ executionId: "exec-1", status: "queued" }, 202, true);
      }
      const body = pollBodies[Math.min(poll, pollBodies.length - 1)];
      poll++;
      return jsonResponse(body, 200, true);
    });
  }

  it('18a. posts mode:"async" and goes to queued without running anything', async () => {
    const fetchMock = stubAsyncFetch([{ executionId: "exec-1", status: "queued" }]);
    vi.stubGlobal("fetch", fetchMock);

    const promise = useExecutionStore.getState().executeAsync("wf-1");
    await vi.waitFor(() => expect(useExecutionStore.getState().status).toBe("queued"));

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ mode: "async" });
    expect(useExecutionStore.getState().isPanelOpen).toBe(true);

    useExecutionStore.getState().reset(); // stop the poll loop
    await promise;
  });

  it("18b. polls queued -> running -> success and then stops", async () => {
    const fetchMock = stubAsyncFetch([
      { executionId: "exec-1", status: "running" },
      { executionId: "exec-1", status: "success", result: { items: [{ json: { ok: true } }] } },
      { executionId: "exec-1", status: "success" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await useExecutionStore.getState().executeAsync("wf-1");

    const state = useExecutionStore.getState();
    expect(state.status).toBe("success");
    expect(state.executionId).toBe("exec-1");
    expect(state.result).toEqual({ items: [{ json: { ok: true } }] });

    // Stopped at the terminal state: no further GET after the success.
    const getsAfterSuccess = fetchMock.mock.calls.filter((c) => c[1]?.method !== "POST").length;
    expect(getsAfterSuccess).toBe(2);
  });

  it("18c. stops polling on a terminal error and keeps the error detail", async () => {
    vi.stubGlobal(
      "fetch",
      stubAsyncFetch([
        { executionId: "exec-1", status: "error", error: { code: "WORKER_CRASHED", message: "abandoned" } },
      ])
    );

    await useExecutionStore.getState().executeAsync("wf-1");

    expect(useExecutionStore.getState().status).toBe("error");
    expect(useExecutionStore.getState().error).toMatchObject({ code: "WORKER_CRASHED" });
  });

  it("19. leaves the synchronous path completely unchanged", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { executionId: "exec-sync", status: "success", result: { items: [{ json: {} }] } },
        200,
        true
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await useExecutionStore.getState().execute("wf-1");

    // One request, no mode field, no polling.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/workflows/wf-1/execute");
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(useExecutionStore.getState().status).toBe("success");
    expect(useExecutionStore.getState().executionId).toBe("exec-sync");
  });
});

