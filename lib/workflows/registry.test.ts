import { describe, it, expect } from "vitest";
import "./definitions"; // populate the registry
import {
  getNodeDefinition,
  getAllNodeDefinitions,
  getNodeDefinitionsByCategory,
  isRegisteredNodeType,
  registerNode,
} from "./registry";

const EXPECTED_TYPES = [
  "manualTrigger",
  "webhookTrigger",
  "scheduleTrigger",
  "httpRequest",
  "set",
  "if",
  "switch",
  "transform",
  "merge",
  "delay",
  "code",
];

describe("Node Registry", () => {
  it("registers exactly the 11 built-in node types", () => {
    const all = getAllNodeDefinitions();
    const types = all.map((d) => d.type).sort();
    expect(types).toEqual([...EXPECTED_TYPES].sort());
  });

  it("getNodeDefinition returns the right definition by type", () => {
    const def = getNodeDefinition("httpRequest");
    expect(def?.displayName).toBe("HTTP Request");
    expect(def?.category).toBe("action");
  });

  it("getNodeDefinition returns undefined for an unknown type", () => {
    expect(getNodeDefinition("doesNotExist")).toBeUndefined();
  });

  it("isRegisteredNodeType reflects the registry contents", () => {
    expect(isRegisteredNodeType("httpRequest")).toBe(true);
    expect(isRegisteredNodeType("doesNotExist")).toBe(false);
  });

  it("getNodeDefinitionsByCategory filters correctly", () => {
    const triggers = getNodeDefinitionsByCategory("trigger");
    expect(triggers.map((d) => d.type).sort()).toEqual(
      ["manualTrigger", "scheduleTrigger", "webhookTrigger"].sort()
    );
  });

  it("the if node exposes true/false outputs", () => {
    const ifDef = getNodeDefinition("if");
    expect(ifDef?.outputs.map((o) => o.id).sort()).toEqual(["false", "true"]);
  });

  it("throws when registering a duplicate type", () => {
    expect(() =>
      registerNode({
        type: "httpRequest", // already registered
        displayName: "Duplicate",
        description: "",
        category: "action",
        icon: "Globe",
        color: "#000000",
        inputs: [],
        outputs: [],
        configSchema: getNodeDefinition("httpRequest")!.configSchema,
        defaultData: {},
      })
    ).toThrow(/already registered/);
  });
});
