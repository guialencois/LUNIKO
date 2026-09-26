import { describe, it, expect } from "vitest";
import "./switch";
import { getExecutor } from "./registry";
import { makeContext } from "../test-utils";

describe("switch executor", () => {
  it("routes to the outputKey of the first matching rule", async () => {
    const executor = getExecutor("switch")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "switch",
        config: {
          rules: [
            { outputKey: "case1", field: "status", operator: "equals", value: "pending" },
            { outputKey: "case2", field: "status", operator: "equals", value: "done" },
          ],
        },
        input: { items: [{ json: { status: "done" } }] },
      })
    );
    expect(result.nextHandles).toEqual(["case2"]);
  });

  it("routes to default when no rule matches", async () => {
    const executor = getExecutor("switch")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "switch",
        config: {
          rules: [{ outputKey: "case1", field: "status", operator: "equals", value: "pending" }],
        },
        input: { items: [{ json: { status: "done" } }] },
      })
    );
    expect(result.nextHandles).toEqual(["default"]);
  });

  it("routes to default when there are no rules", async () => {
    const executor = getExecutor("switch")!;
    const result = await executor.execute(
      makeContext({ nodeType: "switch", config: { rules: [] } })
    );
    expect(result.nextHandles).toEqual(["default"]);
  });

  it("picks the first matching rule when more than one could match", async () => {
    const executor = getExecutor("switch")!;
    const result = await executor.execute(
      makeContext({
        nodeType: "switch",
        config: {
          rules: [
            { outputKey: "case1", field: "status", operator: "equals", value: "done" },
            { outputKey: "case2", field: "status", operator: "equals", value: "done" },
          ],
        },
        input: { items: [{ json: { status: "done" } }] },
      })
    );
    expect(result.nextHandles).toEqual(["case1"]);
  });
});
