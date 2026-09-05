import { describe, expect, it } from "vitest";
import {
  parseMarkdownDocument,
  restoreWikilinkEscapes,
} from "./markdown-document.js";

describe("editable Markdown documents", () => {
  it("preserves frontmatter exactly while separating the editable body", () => {
    const content =
      "---\r\ntitle: Note\r\ntags: work\r\n---\r\n\r\n# Heading\r\n";

    expect(parseMarkdownDocument(content)).toEqual({
      frontmatter: "---\r\ntitle: Note\r\ntags: work\r\n---\r\n",
      frontmatterRows: [
        { key: "title", value: "Note" },
        { key: "tags", value: "work" },
      ],
      body: "\r\n# Heading\r\n",
      bodyLeadingBreaks: "\r\n",
    });
  });

  it("restores wikilinks escaped by the Markdown serializer", () => {
    expect(
      restoreWikilinkEscapes(
        "Read \\[\\[Strategy|the plan\\]\\] and \\[\\[Roadmap\\]\\].",
      ),
    ).toBe("Read [[Strategy|the plan]] and [[Roadmap]].");
  });
});
