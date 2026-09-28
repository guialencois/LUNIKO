// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExecutionResultPanel } from "./execution-result-panel";
import { useExecutionStore } from "./execution-store";

beforeEach(() => {
  useExecutionStore.setState({
    status: "idle",
    executionId: null,
    result: null,
    error: null,
    isPanelOpen: false,
  });
});

describe("<ExecutionResultPanel />", () => {
  it("renders nothing when the panel is closed", () => {
    const { container } = render(<ExecutionResultPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("3. shows the result on success", () => {
    useExecutionStore.setState({
      status: "success",
      executionId: "e1",
      result: { items: [{ json: { name: "Jackson" } }] },
      error: null,
      isPanelOpen: true,
    });
    render(<ExecutionResultPanel />);
    expect(screen.getByText(/success/i)).toBeInTheDocument();
    expect(screen.getByText(/e1/)).toBeInTheDocument();
    expect(screen.getByText(/Jackson/)).toBeInTheDocument();
  });

  it("4. shows the error, without a stack trace, on failure", () => {
    useExecutionStore.setState({
      status: "error",
      executionId: "e1",
      result: null,
      error: { code: "NODE_EXECUTION_FAILED", message: "Node failed", nodeId: "n1" },
      isPanelOpen: true,
    });
    render(<ExecutionResultPanel />);
    expect(screen.getByText("NODE_EXECUTION_FAILED")).toBeInTheDocument();
    expect(screen.getByText("Node failed")).toBeInTheDocument();
    expect(screen.queryByText(/at Object\.<anonymous>/)).not.toBeInTheDocument();
  });

  it("shows a cancelled state distinctly", () => {
    useExecutionStore.setState({
      status: "cancelled",
      executionId: "e1",
      result: null,
      error: { code: "EXECUTION_CANCELLED", message: "Execution was cancelled" },
      isPanelOpen: true,
    });
    render(<ExecutionResultPanel />);
    // /cancelled/i casava com TRÊS nós deste mesmo render — o rótulo de
    // estado, o código do erro e a mensagem —, e `getByText` exige um só.
    // O nome do teste é "distinctly", então o que interessa é exatamente
    // cada um desses três, não "existe algo escrito cancelled". Textos
    // exatos, como o teste 4 acima já faz.
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("EXECUTION_CANCELLED")).toBeInTheDocument();
    expect(screen.getByText("Execution was cancelled")).toBeInTheDocument();
  });
});
