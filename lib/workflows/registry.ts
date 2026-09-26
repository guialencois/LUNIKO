import type { z } from "zod";
import type { NodeCategory, NodePortDefinition } from "./types";

export interface NodeDefinition {
  type: string;
  displayName: string;
  description: string;
  category: NodeCategory;
  /** lucide-react icon name, resolved by the UI layer — not imported here. */
  icon: string;
  color: string;
  inputs: NodePortDefinition[];
  outputs: NodePortDefinition[];
  configSchema: z.ZodTypeAny;
  defaultData: Record<string, unknown>;
}

const registry = new Map<string, NodeDefinition>();

/**
 * Registers a node definition. Throws on duplicate `type` registration —
 * that's a programming error (two definitions claiming the same type),
 * not a runtime condition to handle gracefully.
 */
export function registerNode(definition: NodeDefinition): void {
  if (registry.has(definition.type)) {
    throw new Error(`Node type "${definition.type}" is already registered`);
  }
  registry.set(definition.type, definition);
}

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return registry.get(type);
}

export function getAllNodeDefinitions(): NodeDefinition[] {
  return Array.from(registry.values());
}

export function getNodeDefinitionsByCategory(
  category: NodeCategory
): NodeDefinition[] {
  return getAllNodeDefinitions().filter((def) => def.category === category);
}

export function isRegisteredNodeType(type: string): boolean {
  return registry.has(type);
}
