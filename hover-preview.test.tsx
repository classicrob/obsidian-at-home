// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { findFocusElement, HOVER_FOCUS_CLASS, revealFocusElement } from "./hover-preview.js";
import { remarkBlockAnchors, remarkWikilinks } from "./wikilink-markdown.js";

const transcript = [
  "# Transcript of [[Sync]]",
  "",
  "## Key decisions",
  "",
  "- **00:00:05** Me: Hello there. ^t-00-00-05",
  "- **00:12:30** Them: Ship on Friday. ^t-00-12-30",
  "",
  "Closing thoughts ^end",
].join("\n");

describe("hover preview block focus", () => {
  it("renders block ids and headings as data attributes without the marker text", () => {
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikilinks, remarkBlockAnchors]}>
        {transcript}
      </ReactMarkdown>,
    );
    const block = findFocusElement(container, { kind: "block", id: "t-00-12-30" });
    expect(block?.tagName).toBe("LI");
    expect(block?.textContent).toBe("00:12:30 Them: Ship on Friday.");
    expect(container.textContent).not.toContain("^t-00-12-30");
    expect(findFocusElement(container, { kind: "block", id: "end" })?.tagName).toBe("P");
    expect(findFocusElement(container, { kind: "heading", text: "key decisions" })?.tagName).toBe("H2");
    expect(findFocusElement(container, { kind: "block", id: "missing" })).toBeNull();
  });

  it("marks the focused element and moves an earlier mark", () => {
    const { container } = render(
      <div>
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikilinks, remarkBlockAnchors]}>
          {transcript}
        </ReactMarkdown>
      </div>,
    );
    const body = container.firstElementChild as HTMLElement;
    const first = findFocusElement(body, { kind: "block", id: "t-00-00-05" })!;
    const second = findFocusElement(body, { kind: "block", id: "t-00-12-30" })!;
    revealFocusElement(body, first);
    expect(first.classList.contains(HOVER_FOCUS_CLASS)).toBe(true);
    revealFocusElement(body, second);
    expect(first.classList.contains(HOVER_FOCUS_CLASS)).toBe(false);
    expect(second.classList.contains(HOVER_FOCUS_CLASS)).toBe(true);
  });
});
