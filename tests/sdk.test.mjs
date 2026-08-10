import { describe, expect, test } from "bun:test";
import { createRateLimiter, createTool, defineTool } from "../src/sdk.ts";

describe("custom tool SDK", () => {
  test("factories isolate state and reset creates fresh state", () => {
    const make = defineTool({
      id: "counter",
      name: "Counter",
      icon: "C",
      hint: "test",
      createState: () => ({ hits: 0 }),
      onDown: (state) => state.hits++,
    });
    const first = make();
    const second = make();
    const fake = {};
    first.onDown(fake, {});
    expect(first).not.toBe(second);
    first.reset();
    expect(first.id).toBe("counter");
  });

  test("single-instance helper validates definitions", () => {
    expect(createTool({ id: "x", name: "X", icon: "X", hint: "x", createState: () => 1 }).id).toBe(
      "x",
    );
    expect(() =>
      defineTool({ id: "", name: "X", icon: "X", hint: "x", createState: () => 1 }),
    ).toThrow();
  });

  test("rate limiter is fractional and burst bounded", () => {
    const limiter = createRateLimiter(10, 3);
    expect(limiter.take(0.05)).toBe(0);
    expect(limiter.take(0.05)).toBe(1);
    expect(limiter.take(10)).toBe(3);
    limiter.reset();
    expect(limiter.take(0)).toBe(0);
  });
});
