import { describe, expect, it } from "vitest";
import {
  extractWikilinkReferences,
  resolveWikilinkPath,
} from "./wikilinks.js";

describe("extractWikilinkReferences", () => {
  it("extracts plain and aliased links while ignoring embeds", () => {
    expect(
      extractWikilinkReferences(
        "See [[Roadmap]] and [[Notes/Strategy|the strategy]]. ![[Diagram]]",
      ),
    ).toEqual(["Roadmap", "Notes/Strategy"]);
  });

  it("deduplicates repeated link targets", () => {
    expect(extractWikilinkReferences("[[One]] [[One|again]]")).toEqual(["One"]);
  });
});

describe("resolveWikilinkPath", () => {
  const paths = [
    "Roadmap.md",
    "archive/Strategy.md",
    "examples/Strategy.md",
    "examples/Current note.md",
    "examples/Version 1.2.md",
  ];

  it("prefers a note in the current folder", () => {
    expect(
      resolveWikilinkPath("Strategy", "examples/Current note.md", paths),
    ).toEqual({ path: "examples/Strategy.md", exists: true });
  });

  it("resolves a root-relative path and ignores heading fragments", () => {
    expect(
      resolveWikilinkPath("archive/Strategy#Decision", "examples/Current note.md", paths),
    ).toEqual({ path: "archive/Strategy.md", exists: true });
  });

  it("supports periods in extensionless note names", () => {
    expect(
      resolveWikilinkPath("Version 1.2", "examples/Current note.md", paths),
    ).toEqual({ path: "examples/Version 1.2.md", exists: true });
  });

  it("keeps missing notes clickable at an inferred same-folder path", () => {
    expect(
      resolveWikilinkPath("Future note", "examples/Current note.md", paths),
    ).toEqual({ path: "examples/Future note.md", exists: false });
  });
});
