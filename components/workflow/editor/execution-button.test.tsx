// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExecutionButton } from "./execution-button";
import { useExecutionStore } from "./execution-store";
import { useWorkflowEditorStore } from "./workflow-editor-store";

beforeEach(() => {
  useExecutionStore.setState({
    status: "idle",
    executionId: null,
    result: null,
    error: null,
    isPanelOpen: false,
  });
  useWorkflowEditorStore.setState({ isDirty: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("<ExecutionButton />", () => {
  it("1. renders an Execute button that calls the API when clicked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ executionId: "e1", status: "success", result: { items: [] } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<ExecutionButton workflowId="wf-1" />);
    fireEvent.click(screen.getByRole("button", { name: /execute/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflows/wf-1/execute",
      expect.objectContaining({ method: "POST" })
    ));
  });

  it("2. shows a loading state and disables the button while running", async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => (resolveFetch = resolve)))
    );

    render(<ExecutionButton workflowId="wf-1" />);
    fireEvent.click(screen.getByRole("button", { name: /execute/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /running/i })).toBeDisabled());

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ executionId: "e1", status: "success", result: { items: [] } }),
    });
  });

  it("shows a warning when the editor has unsaved changes", () => {
    useWorkflowEditorStore.setState({ isDirty: true });
    render(<ExecutionButton workflowId="wf-1" />);
    expect(screen.getByText(/não serão executadas/i)).toBeInTheDocument();
  });

  it("does not show the unsaved-changes warning when the editor is clean", () => {
    useWorkflowEditorStore.setState({ isDirty: false });
    render(<ExecutionButton workflowId="wf-1" />);
    expect(screen.queryByText(/não serão executadas/i)).not.toBeInTheDocument();
  });
});
