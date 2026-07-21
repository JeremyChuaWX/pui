import { describe, expect, test } from "bun:test";
import {
  REFERENCE_INSTRUCTION,
  REFERENCE_MARKER,
  buildEditorBuffer,
  extractEditedPrompt,
} from "./external-editor.js";

describe("external editor buffer", () => {
  test("places the last assistant response above an ignored reference block", () => {
    expect(buildEditorBuffer("Last response\n", "my draft")).toBe(
      `Last response\n\n${REFERENCE_MARKER}\n${REFERENCE_INSTRUCTION}\n\nmy draft`,
    );
  });

  test("leaves a draft alone when there is no assistant response", () => {
    expect(buildEditorBuffer("", "my draft")).toBe("my draft");
  });

  test("returns only text below the reference marker", () => {
    const buffer = buildEditorBuffer("reference", "edited prompt\nwith detail\n");
    expect(extractEditedPrompt(buffer)).toBe("edited prompt\nwith detail");
  });

  test("normalizes Windows newlines in a reference buffer", () => {
    const buffer = `reference\r\n\r\n${REFERENCE_MARKER}\r\n${REFERENCE_INSTRUCTION}\r\n\r\nnew prompt\r\n`;
    expect(extractEditedPrompt(buffer)).toBe("new prompt");
  });
});
