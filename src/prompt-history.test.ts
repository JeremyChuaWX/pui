import { describe, expect, test } from "bun:test";
import { PromptHistory } from "./prompt-history.js";

describe("PromptHistory", () => {
  test("navigates from newest to oldest and back to the draft", () => {
    const history = new PromptHistory();
    history.add("first prompt");
    history.add("second prompt");

    expect(history.previous("unfinished draft")).toBe("second prompt");
    expect(history.previous("second prompt")).toBe("first prompt");
    expect(history.previous("first prompt")).toBeUndefined();
    expect(history.next()).toBe("second prompt");
    expect(history.next()).toBe("unfinished draft");
    expect(history.next()).toBeUndefined();
  });

  test("trims entries, ignores blanks and consecutive duplicates", () => {
    const history = new PromptHistory();
    history.add("  repeated prompt  ");
    history.add("repeated prompt");
    history.add("   ");

    expect(history.previous("")).toBe("repeated prompt");
    expect(history.previous("repeated prompt")).toBeUndefined();
  });

  test("limits retained entries", () => {
    const history = new PromptHistory(2);
    history.add("first");
    history.add("second");
    history.add("third");

    expect(history.previous("")).toBe("third");
    expect(history.previous("third")).toBe("second");
    expect(history.previous("second")).toBeUndefined();
  });

  test("starts a fresh traversal after browsing is reset", () => {
    const history = new PromptHistory();
    history.add("first");
    history.add("second");

    expect(history.previous("old draft")).toBe("second");
    history.resetBrowsing();
    expect(history.previous("new draft")).toBe("second");
    expect(history.next()).toBe("new draft");
  });
});
