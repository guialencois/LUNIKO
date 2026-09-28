// Popula o registro ANTES de qualquer consulta. Sem esta linha o mapa fica
// vazio em produção, `getExecutor` não acha nada e TODA execução de workflow
// morre com NODE_EXECUTOR_NOT_FOUND (ver a busca logo abaixo). Até agora o
// único lugar do projeto que importava `./executors` era um arquivo de teste,
// então a suíte unitária passava e o produto estava quebrado.
//
// É o mesmo padrão que o registro irmão já usa: lib/workflows/schema.ts faz
// `import "./definitions"` exatamente por este motivo. Aqui a importação vive
// no módulo que CONSOME o registro, e não em cada ponto de entrada, para não
// depender de alguém lembrar de repeti-la num caminho novo.
import "./executors";
import { getExecutor } from "./executors/registry";
import type { EffectRunner } from "./effects";
import { buildNodeExecutionContext } from "./context";
import { ExecutionEngineError, ExecutionErrorCode } from "./errors";
import { EXECUTION_LIMITS } from "./types";
import type {
  ExecutionPlan,
  ExecutionLogger,
  NodeInput,
  NodeOutput,
  NodeExecutionResult,
  ExecutionError,
} from "./types";

export interface RunPlanOptions {
  executionId: string;
  workflowId: string;
  workspaceId: string;
  initialInput: NodeInput;
  logger: ExecutionLogger;
  signal?: AbortSignal;
  variables?: Record<string, unknown>;
  /** Fase 10 — worker path only. See NodeExecutionContext.epoch. */
  epoch?: number;
  /** Fase 10 — worker path only. See NodeExecutionContext.effects. */
  effects?: EffectRunner;
}

export interface RunPlanOutcome {
  status: "success" | "error" | "cancelled";
  /** Outputs of every executed "sink" node (no outgoing edge led to another
   *  executed node), concatenated. Covers both the linear case and a
   *  workflow that ends in multiple unmerged branches. */
  finalOutput?: NodeOutput;
  /** Every node that was actually executed (success or error) — skipped
   *  nodes (branch not taken) are intentionally absent, not included with
   *  some "skipped" status (item 18: não executar branches não selecionadas). */
  nodeResults: Map<
    string,
    NodeExecutionResult & { nodeType: string; startedAt: Date; finishedAt: Date }
  >;
  error?: ExecutionError;
}

export async function runExecutionPlan(
  plan: ExecutionPlan,
  options: RunPlanOptions
): Promise<RunPlanOutcome> {
  const nodeResults = new Map<
    string,
    NodeExecutionResult & { nodeType: string; startedAt: Date; finishedAt: Date }
  >();
  const nodesById = new Map(plan.nodes.map((n) => [n.nodeId, n]));
  const startedAt = Date.now();

  for (const nodeId of plan.topologicalOrder) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        nodeResults,
        error: { code: ExecutionErrorCode.EXECUTION_CANCELLED, message: "Execution was cancelled" },
      };
    }

    if (Date.now() - startedAt > EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS) {
      const error: ExecutionError = {
        code: ExecutionErrorCode.EXECUTION_TIMEOUT,
        message: `Execution exceeded the ${EXECUTION_LIMITS.MAX_EXECUTION_TIME_MS}ms time limit`,
      };
      return { status: "error", nodeResults, error };
    }

    const node = nodesById.get(nodeId)!;
    const incomingEdges = plan.edges.filter((e) => e.target === nodeId);

    // ---- Determine reachability & aggregate input ----
    let input: NodeInput;
    const inputsByHandle: Record<string, NodeInput> = {};

    if (nodeId === plan.manualTriggerNodeId) {
      input = options.initialInput;
    } else {
      const activeEdges = incomingEdges.filter((edge) => {
        const sourceResult = nodeResults.get(edge.source);
        if (!sourceResult || sourceResult.status !== "success") return false;
        if (!sourceResult.nextHandles) return true; // non-branching node: all edges active
        if (edge.sourceHandle == null) return true;
        return sourceResult.nextHandles.includes(edge.sourceHandle);
      });

      if (activeEdges.length === 0) {
        // Not reachable this run (branch not taken, or an upstream node
        // errored/was itself skipped) — skip silently, per item 18/19.
        continue;
      }

      const allItems: NodeInput["items"] = [];
      for (const edge of activeEdges) {
        const sourceOutput = nodeResults.get(edge.source)?.output;
        const items = sourceOutput?.items ?? [];
        allItems.push(...items);

        const handleKey = edge.targetHandle ?? "input";
        inputsByHandle[handleKey] = {
          items: [...(inputsByHandle[handleKey]?.items ?? []), ...items],
        };
      }
      input = { items: allItems };
    }

    // ---- Execute ----
    const executor = getExecutor(node.nodeType);
    if (!executor) {
      const error: ExecutionError = {
        code: ExecutionErrorCode.NODE_EXECUTOR_NOT_FOUND,
        message: `No executor registered for node type "${node.nodeType}"`,
        nodeId,
        nodeType: node.nodeType,
      };
      const notFoundAt = new Date();
      nodeResults.set(nodeId, {
        status: "error",
        durationMs: 0,
        error,
        nodeType: node.nodeType,
        startedAt: notFoundAt,
        finishedAt: notFoundAt,
      });
      return { status: "error", nodeResults, error };
    }

    const context = buildNodeExecutionContext({
      executionId: options.executionId,
      workflowId: options.workflowId,
      workspaceId: options.workspaceId,
      nodeId,
      nodeType: node.nodeType,
      config: node.config,
      input,
      inputsByHandle,
      previousResults: nodeResults,
      variables: options.variables ?? {},
      signal: options.signal,
      logger: options.logger,
      epoch: options.epoch,
      effects: options.effects,
    });

    let result: NodeExecutionResult;
    const nodeStartedAt = new Date();
    try {
      result = await executor.execute(context);
    } catch (err) {
      const engineError =
        err instanceof ExecutionEngineError
          ? err.toExecutionError()
          : {
              code: ExecutionErrorCode.NODE_EXECUTION_FAILED,
              message: err instanceof Error ? err.message : "Unknown node execution error",
              nodeId,
              nodeType: node.nodeType,
            };
      result = { status: "error", durationMs: 0, error: engineError };
    }
    const nodeFinishedAt = new Date();

    nodeResults.set(nodeId, {
      ...result,
      nodeType: node.nodeType,
      startedAt: nodeStartedAt,
      finishedAt: nodeFinishedAt,
    });
    options.logger.info(`node "${nodeId}" (${node.nodeType}) -> ${result.status}`, {
      nodeId,
      nodeType: node.nodeType,
      durationMs: result.durationMs,
    });

    if (result.status === "error") {
      // Fail-fast: item 22's lifecycle is running -> error as a whole-run
      // transition, not "some branches failed, others kept going".
      return {
        status: "error",
        nodeResults,
        error: result.error ?? {
          code: ExecutionErrorCode.NODE_EXECUTION_FAILED,
          message: "Node failed with no error detail",
          nodeId,
          nodeType: node.nodeType,
        },
      };
    }
  }

  // ---- Success: collect sink node outputs ----
  const finalItems: NodeOutput["items"] = [];
  for (const [nodeId, result] of nodeResults) {
    if (result.status !== "success") continue;
    const hasExecutedSuccessor = plan.edges.some(
      (e) => e.source === nodeId && nodeResults.get(e.target)?.status === "success"
    );
    if (!hasExecutedSuccessor && result.output) {
      finalItems.push(...result.output.items);
    }
  }

  return {
    status: "success",
    finalOutput: { items: finalItems },
    nodeResults,
  };
}
