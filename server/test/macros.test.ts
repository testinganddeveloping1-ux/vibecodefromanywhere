import { describe, expect, test } from "vitest";
import { macroToWrites } from "../src/macros/macro_engine";

describe("macroToWrites", () => {
  test("turns Ctrl+C into ETX", () => {
    const writes = macroToWrites([{ type: "keys", keys: ["CTRL_C"] }]);
    expect(writes).toEqual(["\u0003"]);
  });

  test("supports plain text", () => {
    const writes = macroToWrites([{ type: "text", text: "hello" }]);
    expect(writes).toEqual(["hello"]);
  });

  test("supports Shift+Tab as a key", () => {
    const writes = macroToWrites([{ type: "keys", keys: ["SHIFT_TAB"] }]);
    // Common terminal encoding for Shift+Tab (BackTab)
    expect(writes).toEqual(["\u001b[Z"]);
  });
});
