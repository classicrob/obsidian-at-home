import { describe, expect, it } from "vitest";
import {
  decodeLocalMarkdownPath,
  decodeWikilinkUrl,
  extractLocalMarkdownPaths,
  splitWikilinkText,
  WIKILINK_URL_PREFIX,
} from "./wikilink-markdown.js";

describe("local Markdown paths", () => {
  it("decodes absolute, relative, file URL, and tldraw links", () => {
    expect(
      decodeLocalMarkdownPath(
        "/Users/me/Notes/Example%20document.md",
      ),
    ).toBe("/Users/me/Notes/Example document.md");
    expect(decodeLocalMarkdownPath("../Concepts/Learning.markdown#definition")).toBe(
      "../Concepts/Learning.markdown",
    );
    expect(decodeLocalMarkdownPath("file:///Users/me/Notes/Idea.md")).toBe(
      "/Users/me/Notes/Idea.md",
    );
    expect(
      decodeLocalMarkdownPath(
        "examples/Team%20workshops%20(whiteboard).tldraw",
      ),
    ).toBe("examples/Team workshops (whiteboard).tldraw");
  });

  it("rejects web links and extracts unique local note destinations", () => {
    expect(decodeLocalMarkdownPath("https://example.com/readme.md")).toBeNull();
    expect(
      extractLocalMarkdownPaths(
        "[Concept](/Notes/Concept%20note.md) [again](/Notes/Concept%20note.md) ![image](diagram.md) [web](https://example.com/a.md)",
      ),
    ).toEqual(["/Notes/Concept note.md"]);
  });

  it("extracts tldraw destinations containing balanced parentheses", () => {
    expect(
      extractLocalMarkdownPaths(
        "[the workshop whiteboard](examples/Team%20workshops%20(whiteboard).tldraw)",
      ),
    ).toEqual([
      "examples/Team workshops (whiteboard).tldraw",
    ]);
  });
});

describe("splitWikilinkText", () => {
  it("turns plain and aliased wikilinks into Markdown link nodes", () => {
    expect(splitWikilinkText("Read [[Folder/Note]] or [[Other|this one]].")).toEqual([
      { type: "text", value: "Read " },
      {
        type: "link",
        url: `${WIKILINK_URL_PREFIX}Folder%2FNote`,
        children: [{ type: "text", value: "Note" }],
      },
      { type: "text", value: " or " },
      {
        type: "link",
        url: `${WIKILINK_URL_PREFIX}Other`,
        children: [{ type: "text", value: "this one" }],
      },
      { type: "text", value: "." },
    ]);
  });

  it("does not turn Obsidian embeds into ordinary links", () => {
    expect(splitWikilinkText("![[Diagram]]")).toBeNull();
  });
});

describe("decodeWikilinkUrl", () => {
  it("round trips unicode and punctuation", () => {
    const reference = "What is worth our time?";
    expect(
      decodeWikilinkUrl(`${WIKILINK_URL_PREFIX}${encodeURIComponent(reference)}`),
    ).toBe(reference);
  });
});
