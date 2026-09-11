// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown } from "tiptap-markdown";
import { mapPositionAcrossChange, wikilinkDecorations } from "./live-markdown-editor.js";

const reference = "websim/Talking with Natasha about Websim’s exploratory next chapter#Websim can support exploration without defining what I must keep building";
const alias = "Continuing as a founder also does not require keeping websim.com alive indefinitely";

describe("editor wikilinks across text fragments", () => {
  it("recognizes the full reference and alias when a domain creates a link mark", () => {
    const editor = new Editor({
      extensions: [StarterKit, Link, Markdown.configure({ linkify: true })],
      content: `Before [[${reference}|${alias}]] after`,
    });
    try {
      let linked = false;
      editor.state.doc.descendants(node => {
        if (node.text === "websim.com" && node.marks.some(mark => mark.type.name === "link")) linked = true;
      });
      expect(linked).toBe(true);
      const decorations = wikilinkDecorations(editor.state.doc, { from: 0, to: 0 }).find();
      const label = decorations.find(d => (d as any).type.attrs["data-wikilink-reference"] === reference);
      expect(label).toBeDefined();
      expect(editor.state.doc.textBetween(label!.from, label!.to)).toBe(alias);
    } finally { editor.destroy(); }
  });
});

describe("caret mapping across external changes", () => {
  // Both documents must come from one schema: ProseMirror compares node
  // types by identity, exactly as the live editor's setContent path does.
  const shared = new Editor({
    extensions: [StarterKit, Markdown.configure({ tightLists: true })],
    content: "",
  });
  const docFor = (markdown: string) => {
    shared.commands.setContent(markdown, false);
    return shared.state.doc;
  };

  it("keeps a caret that sits before the changed region", () => {
    const previous = docFor("# Title\n\nMy notes here.\n\nTranscript line one.");
    const next = docFor("# Title\n\nMy notes here.\n\nTranscript line one.\n\nTranscript line two.");
    expect(mapPositionAcrossChange(previous, next, 12)).toBe(12);
  });

  it("shifts a caret that sits after an insertion by the inserted size", () => {
    const previous = docFor("# Title\n\nMy notes here.");
    const next = docFor("# Title\n\nAgent paragraph.\n\nMy notes here.");
    // Just after the final "." of the last paragraph.
    const caret = previous.content.size - 1;
    const inserted = next.content.size - previous.content.size;
    expect(mapPositionAcrossChange(previous, next, caret)).toBe(caret + inserted);
    expect(next.textBetween(caret + inserted - 5, caret + inserted)).toBe("here.");
  });

  it("clamps a caret inside a region that shrank", () => {
    const previous = docFor("# Title\n\nA long paragraph that will be replaced entirely.\n\nEnd.");
    const next = docFor("# Title\n\nShort.\n\nEnd.");
    const mapped = mapPositionAcrossChange(previous, next, 30);
    expect(mapped).toBeLessThanOrEqual(next.content.size);
    expect(mapped).toBeGreaterThanOrEqual(9);
  });

  it("returns the caret unchanged for identical documents", () => {
    const previous = docFor("Same.");
    expect(mapPositionAcrossChange(previous, docFor("Same."), 3)).toBe(3);
  });
});
