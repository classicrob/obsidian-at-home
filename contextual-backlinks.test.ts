import { describe, expect, it } from "vitest";
import {
  createWikilinkPathResolver,
  extractContextualLinks,
  missingNoteKey,
} from "./contextual-backlinks.js";

describe("contextual links to missing notes", () => {
  const resolve = createWikilinkPathResolver(["Existing.md", "notes/Source.md"]);
  const content = [
    "# Reading",
    "",
    "A post by [[@ Simon Willison|Simon]] linking [[Existing]].",
    "",
    "- Also see [[folder/@ Simon Willison#Games]]",
  ].join("\n");

  it("skips unresolved links by default", () => {
    const targets = extractContextualLinks(content, "notes/Source.md", resolve)
      .map((occurrence) => occurrence.targetPath);
    expect(targets).toEqual(["Existing.md"]);
  });

  it("indexes unresolved links under the missing note's name", () => {
    const occurrences = extractContextualLinks(content, "notes/Source.md", resolve, {
      includeMissing: true,
    });
    const key = missingNoteKey("@ Simon Willison.md");
    const missing = occurrences.filter((occurrence) => occurrence.targetPath === key);
    expect(missing).toHaveLength(2);
    expect(missing[0]!.headings).toEqual(["Reading"]);
    expect(missing[0]!.context).toContain("A post by [[@ Simon Willison|Simon]]");
  });

  it("keys a hovered fallback path the same as the link text", () => {
    expect(missingNoteKey("notes/@ Simon Willison.md")).toBe(
      missingNoteKey("@ simon willison"),
    );
  });
});
