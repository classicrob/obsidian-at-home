import { describe, expect, it } from "vitest";
import {
  decodeLocalMarkdownPath,
  decodeWikilinkUrl,
  extractLocalMarkdownPaths,
  parseWikilinkSubpath,
  remarkBlockAnchors,
  splitWikilinkText,
  WIKILINK_URL_PREFIX,
} from "./wikilink-markdown.js";

describe("local Markdown paths", () => {
  it("decodes absolute, relative, file URL, and tldraw links", () => {
    expect(
      decodeLocalMarkdownPath(
        "/Users/me/Notes/Continual%20learning.md",
      ),
    ).toBe("/Users/me/Notes/Continual learning.md");
    expect(decodeLocalMarkdownPath("../Concepts/Learning.markdown#definition")).toBe(
      "../Concepts/Learning.markdown",
    );
    expect(decodeLocalMarkdownPath("file:///Users/me/Notes/Idea.md")).toBe(
      "/Users/me/Notes/Idea.md",
    );
    expect(
      decodeLocalMarkdownPath(
        "websim/I-%20Prompt%20arenas%20into%20existence%20(whiteboard).tldraw",
      ),
    ).toBe("websim/I- Prompt arenas into existence (whiteboard).tldraw");
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
        "[the arenas whiteboard](websim/I-%20Prompt%20arenas%20into%20existence%20(whiteboard).tldraw)",
      ),
    ).toEqual([
      "websim/I- Prompt arenas into existence (whiteboard).tldraw",
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

describe("wikilink subpaths", () => {
  it("parses block and heading subpaths, ignoring aliases", () => {
    expect(parseWikilinkSubpath("Note")).toBeNull();
    expect(parseWikilinkSubpath("Note#^t-00-12-30|12:30")).toEqual({
      kind: "block",
      id: "t-00-12-30",
    });
    expect(parseWikilinkSubpath("Note#Key  *Decisions*|x")).toEqual({
      kind: "heading",
      text: "key decisions",
    });
    expect(parseWikilinkSubpath("Note#A#B")).toEqual({ kind: "heading", text: "b" });
    expect(parseWikilinkSubpath("Note#^")).toBeNull();
  });

  it("tags block anchors and headings and hides the marker text", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "heading",
          depth: 2,
          children: [{ type: "text", value: "Key *Decisions*" }],
        },
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [
                {
                  type: "paragraph",
                  children: [
                    { type: "strong", children: [{ type: "text", value: "00:12:30" }] },
                    { type: "text", value: " Them: ship Friday ^t-00-12-30" },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [{ type: "text", value: "Plain block ^abc" }],
        },
        {
          type: "paragraph",
          children: [{ type: "text", value: "Not an anchor: a^b" }],
        },
      ],
    };
    remarkBlockAnchors()(tree as never);
    type Node = {
      value?: string;
      data?: { hProperties?: Record<string, unknown> };
      children: Node[];
    };
    const [heading, list, block, plain] = tree.children as unknown as Node[];
    expect(heading!.data?.hProperties).toEqual({ "data-heading": "key decisions" });
    const item = list!.children[0]!;
    expect(item.data?.hProperties).toEqual({ "data-block-id": "t-00-12-30" });
    expect(item.children[0]!.children[1]!.value).toBe(" Them: ship Friday");
    expect(block!.data?.hProperties).toEqual({ "data-block-id": "abc" });
    expect(block!.children[0]!.value).toBe("Plain block");
    expect(plain!.data).toBeUndefined();
  });
});
