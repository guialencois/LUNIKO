import { describe, it, expect } from "vitest";
import "./set";
import { getExecutor } from "./registry";
import { makeContext } from "../test-utils";

describe("set executor", () => {
  it("merges config.values into every item's json", async () => {
    const executor = getExecutor("set")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "set",
        config: { values: { status: "ok" } },
        input: { items: [{ json: { name: "Jackson" } }] },
      })
    );
    expect(result.status).toBe("success");
    expect(result.output?.items).toEqual([{ json: { name: "Jackson", status: "ok" } }]);
  });

  it("passes items through unchanged when values is empty", async () => {
    const executor = getExecutor("set")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "set",
        config: { values: {} },
        input: { items: [{ json: { name: "Jackson" } }] },
      })
    );
    expect(result.output?.items).toEqual([{ json: { name: "Jackson" } }]);
  });
});
