import { describe, expect, test } from "bun:test";
import { waitFor } from "../scripts/lib/browser.mjs";

describe("browser waitFor", () => {
  test("forwards the trusted expression without constructing new code", async () => {
    const expressions = [];
    const cdp = {
      async send(_method, { expression }) {
        expressions.push(expression);
        return { result: { value: true } };
      },
    };

    await waitFor(cdp, "session", "window.ready === true");

    expect(expressions).toEqual(["window.ready === true"]);
  });

  test("keeps polling when page evaluation briefly fails", async () => {
    let attempts = 0;
    const cdp = {
      async send() {
        attempts += 1;
        if (attempts === 1) return { exceptionDetails: { text: "navigation" } };
        return { result: { value: true } };
      },
    };

    await waitFor(cdp, "session", "document.body", { timeoutMs: 250 });

    expect(attempts).toBe(2);
  });
});
