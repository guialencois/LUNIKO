import { describe, it, expect } from "vitest";
import "./index"; // populate the executor registry
import { getExecutor, hasExecutor, registerExecutor } from "./registry";

describe("Executor Registry", () => {
  it("has an executor for every implemented node type", () => {
    const implemented = [
      "manualTrigger",
      "set",
      "transform",
      "if",
      "switch",
      "merge",
      "delay",
      "httpRequest",
      "code",
      "webhookTrigger",
      "scheduleTrigger",
    ];
    for (const type of implemented) {
      expect(hasExecutor(type)).toBe(true);
    }
  });

  it("getExecutor returns undefined for an unknown type", () => {
    expect(getExecutor("doesNotExist")).toBeUndefined();
  });

  it("throws when registering a duplicate node type", () => {
    expect(() =>
      registerExecutor({
        nodeType: "set", // already registered
        async execute() {
          return { status: "success" as const, output: { items: [] }, durationMs: 0 };
        },
      })
    ).toThrow(/already registered/);
  });
});
