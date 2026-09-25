import { describe, it, expect } from "vitest";
import "./merge";
import { getExecutor } from "./registry";
import { makeContext } from "../test-utils";

describe("merge executor", () => {
  it("appends items from both inputs when both are present", async () => {
    const executor = getExecutor("merge")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "merge",
        config: { mode: "append" },
        inputsByHandle: {
          input1: { items: [{ json: { from: "A" } }] },
          input2: { items: [{ json: { from: "B" } }] },
        },
      })
    );
    expect(result.status).toBe("success");
    expect(result.output?.items).toEqual([{ json: { from: "A" } }, { json: { from: "B" } }]);
  });

  it("works with only input1 present (input2's branch was skipped upstream)", async () => {
    const executor = getExecutor("merge")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "merge",
        config: { mode: "append" },
        inputsByHandle: { input1: { items: [{ json: { from: "A" } }] } },
      })
    );
    expect(result.status).toBe("success");
    expect(result.output?.items).toEqual([{ json: { from: "A" } }]);
  });

  it("works with only input2 present", async () => {
    const executor = getExecutor("merge")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "merge",
        config: { mode: "append" },
        inputsByHandle: { input2: { items: [{ json: { from: "B" } }] } },
      })
    );
    expect(result.output?.items).toEqual([{ json: { from: "B" } }]);
  });

  it("returns NOT_IMPLEMENTED for any mode other than append", async () => {
    const executor = getExecutor("merge")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "merge",
        config: { mode: "combine" },
        inputsByHandle: { input1: { items: [] } },
      })
    );
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NOT_IMPLEMENTED");
  });
});
