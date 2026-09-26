import { describe, it, expect } from "vitest";
import "./if";
import { getExecutor } from "./registry";
import { makeContext } from "../test-utils";

describe("if executor", () => {
  it("routes to true when the condition matches", async () => {
    const executor = getExecutor("if")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "if",
        config: { conditions: [{ field: "status", operator: "equals", value: "ok" }] },
        input: { items: [{ json: { status: "ok" } }] },
      })
    );
    expect(result.nextHandles).toEqual(["true"]);
  });

  it("routes to false when the condition doesn't match", async () => {
    const executor = getExecutor("if")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "if",
        config: { conditions: [{ field: "status", operator: "equals", value: "ok" }] },
        input: { items: [{ json: { status: "not-ok" } }] },
      })
    );
    expect(result.nextHandles).toEqual(["false"]);
  });

  it("routes to true when there are no conditions at all", async () => {
    const executor = getExecutor("if")!;
    const result = await executor.execute(
      makeContext({ nodeType: "if", config: { conditions: [] } })
    );
    expect(result.nextHandles).toEqual(["true"]);
  });

  it("requires all conditions to match (AND)", async () => {
    const executor = getExecutor("if")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "if",
        config: {
          conditions: [
            { field: "status", operator: "equals", value: "ok" },
            { field: "count", operator: "greaterThan", value: 10 },
          ],
        },
        input: { items: [{ json: { status: "ok", count: 5 } }] },
      })
    );
    expect(result.nextHandles).toEqual(["false"]);
  });

  it("passes the input through unchanged in its output", async () => {
    const executor = getExecutor("if")!;
    const input = { items: [{ json: { a: 1 } }] };
    const result = await executor.execute(makeContext({ nodeType: "if", input }));
    expect(result.output).toEqual(input);
  });
});
