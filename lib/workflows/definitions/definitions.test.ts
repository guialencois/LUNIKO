import { describe, it, expect } from "vitest";
import "./index"; // populate the registry
import { getAllNodeDefinitions } from "../registry";

describe("Node definitions", () => {
  const definitions = getAllNodeDefinitions();

  it("has exactly 11 registered definitions", () => {
    expect(definitions).toHaveLength(11);
  });

  it.each(definitions.map((d) => [d.type, d] as const))(
    "%s has a well-formed definition",
    (_type, def) => {
      expect(def.displayName.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(["trigger", "action", "logic", "data", "utilities", "code"]).toContain(
        def.category
      );
      expect(Array.isArray(def.inputs)).toBe(true);
      expect(Array.isArray(def.outputs)).toBe(true);
      // configSchema.parse(defaultData) must not throw — defaultData has to
      // be a value the node's own schema actually accepts.
      expect(() => def.configSchema.parse(def.defaultData)).not.toThrow();
    }
  );

  it("trigger nodes have no inputs", () => {
    const triggers = definitions.filter((d) => d.category === "trigger");
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger.inputs).toHaveLength(0);
    }
  });

  it("every non-trigger node has at least one input", () => {
    const nonTriggers = definitions.filter((d) => d.category !== "trigger");
    for (const def of nonTriggers) {
      expect(def.inputs.length).toBeGreaterThan(0);
    }
  });

  it("code node's default config is never treated as executable (string only)", () => {
    const codeDef = definitions.find((d) => d.type === "code")!;
    expect(typeof codeDef.defaultData.code).toBe("string");
  });
});
