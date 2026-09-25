import { z } from "zod";
import "./definitions"; // ensures the registry is populated before validation
import { isRegisteredNodeType, getNodeDefinition } from "./registry";
import { CURRENT_SCHEMA_VERSION } from "./types";

export const workflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1).max(200),
  position: workflowPositionSchema,
  data: z.record(z.unknown()).default({}),
  disabled: z.boolean().optional(),
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional(),
});

export const workflowSettingsSchema = z.object({
  executionMode: z.literal("default").default("default"),
});

// Resource limits (Fase 1, item 33 do prompt mestre) — evita workflows
// absurdamente grandes já nesta fase, mesmo sem engine ainda.
export const MAX_NODES_PER_WORKFLOW = 500;
export const MAX_EDGES_PER_WORKFLOW = 2000;

export const workflowDocumentSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    nodes: z.array(workflowNodeSchema).max(MAX_NODES_PER_WORKFLOW),
    edges: z.array(workflowEdgeSchema).max(MAX_EDGES_PER_WORKFLOW),
    settings: workflowSettingsSchema,
  })
  .superRefine((doc, ctx) => {
    const nodeIds = new Set<string>();
    const nodeById = new Map<string, (typeof doc.nodes)[number]>();

    doc.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "id"],
          message: `Duplicate node id: ${node.id}`,
        });
      }
      nodeIds.add(node.id);
      nodeById.set(node.id, node);

      if (!isRegisteredNodeType(node.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "type"],
          message: `Unknown node type: ${node.type}`,
        });
        return;
      }

      const definition = getNodeDefinition(node.type)!;
      const configResult = definition.configSchema.safeParse(node.data);
      if (!configResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "data"],
          message: `Invalid config for node type "${node.type}": ${configResult.error.message}`,
        });
      }
    });

    const edgeIds = new Set<string>();
    doc.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "id"],
          message: `Duplicate edge id: ${edge.id}`,
        });
      }
      edgeIds.add(edge.id);

      const sourceNode = nodeById.get(edge.source);
      if (!sourceNode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "source"],
          message: `Edge references unknown source node: ${edge.source}`,
        });
      }

      const targetNode = nodeById.get(edge.target);
      if (!targetNode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", index, "target"],
          message: `Edge references unknown target node: ${edge.target}`,
        });
      }

      // Handle validation: only meaningful once we know the node and its
      // type is a registered one (an unknown-type issue was already added
      // above for that node, so we don't pile on a second, confusing error).
      if (edge.sourceHandle != null && sourceNode && isRegisteredNodeType(sourceNode.type)) {
        const sourceDefinition = getNodeDefinition(sourceNode.type)!;
        const hasOutput = sourceDefinition.outputs.some((o) => o.id === edge.sourceHandle);
        if (!hasOutput) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["edges", index, "sourceHandle"],
            message: `Node type "${sourceNode.type}" has no output handle "${edge.sourceHandle}"`,
          });
        }
      }

      if (edge.targetHandle != null && targetNode && isRegisteredNodeType(targetNode.type)) {
        const targetDefinition = getNodeDefinition(targetNode.type)!;
        const hasInput = targetDefinition.inputs.some((i) => i.id === edge.targetHandle);
        if (!hasInput) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["edges", index, "targetHandle"],
            message: `Node type "${targetNode.type}" has no input handle "${edge.targetHandle}"`,
          });
        }
      }
    });
  });

export type ValidatedWorkflowDocument = z.infer<typeof workflowDocumentSchema>;

/** Validates an unknown value coming from the client or the database. */
export function parseWorkflowDocument(value: unknown) {
  return workflowDocumentSchema.safeParse(value);
}

export const createWorkflowRequestSchema = z.object({
  name: z.string().min(1).max(200).default("Untitled Workflow"),
  description: z.string().max(2000).optional().default(""),
});

export const updateWorkflowRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(["draft", "active", "inactive"]).optional(),
  document: workflowDocumentSchema.optional(),
});

export { CURRENT_SCHEMA_VERSION };
