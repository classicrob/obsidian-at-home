import { describe, expect, it } from "vitest";
import {
  createMarkdownExcerpt,
  stripYamlFrontmatter,
} from "./preview-markdown.js";

describe("hover preview Markdown", () => {
  it("removes YAML frontmatter while preserving the note body", () => {
    const markdown = "---\ntitle: Strategy\ntags: [work]\n---\n# Strategy\n\nBody.";
    expect(stripYamlFrontmatter(markdown)).toBe("# Strategy\n\nBody.");
  });

  it("cuts long notes at a readable boundary", () => {
    const excerpt = createMarkdownExcerpt(
      `# Note\n\n${"First paragraph. ".repeat(20)}\n\nSecond paragraph.`,
      120,
    );
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.content.endsWith("\n\n…")).toBe(true);
    expect(excerpt.content.length).toBeLessThan(130);
  });
});
