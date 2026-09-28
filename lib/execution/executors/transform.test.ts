import { describe, it, expect } from "vitest";
import "./transform";
import { getExecutor } from "./registry";
import { makeContext } from "../test-utils";

describe("transform executor", () => {
  it("is an identity pass-through regardless of mode", async () => {
    const executor = getExecutor("transform")!;
    const input = { items: [{ json: { name: "Jackson" } }] };
    const result = await executor.execute(
      makeContext({ nodeType: "transform", config: { mode: "map" }, input })
    );
    expect(result.status).toBe("success");
    expect(result.output?.items).toEqual(input.items);
  });

  it("does not mutate the input object", async () => {
    const executor = getExecutor("transform")!;
    const input = { items: [{ json: { name: "Jackson" } }] };
    const result = await executor.execute(makeContext({ nodeType: "transform", input }));
    expect(result.output?.items[0]).not.toBe(input.items[0]);
    expect(result.output?.items[0]?.json).not.toBe(input.items[0]?.json);
  });
});
