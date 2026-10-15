// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { isAllowedIframeHost, parseIframeEmbeds } from "./iframe-embed.js";
import { RawIframeBlock, RawIframeInline } from "./iframe-editor.js";

describe("iframe allowlist", () => {
  it("matches allowlisted hosts and subdomains only", () => {
    expect(isAllowedIframeHost("www.youtube.com")).toBe(true);
    expect(isAllowedIframeHost("www.youtube-nocookie.com")).toBe(true);
    expect(isAllowedIframeHost("player.vimeo.com")).toBe(true);
    expect(isAllowedIframeHost("youtube.com.evil.example")).toBe(false);
    expect(isAllowedIframeHost("notyoutube.com")).toBe(false);
  });

  it("falls back to a link or text for anything not allowlisted", () => {
    expect(parseIframeEmbeds(`<iframe src="https://aphyr.com/posts/302"></iframe>`)).toEqual([
      { kind: "link", href: "https://aphyr.com/posts/302", title: "" },
    ]);
    expect(parseIframeEmbeds(`<iframe src="http://www.youtube.com/embed/x"></iframe>`)[0]!.kind).toBe("link");
    expect(parseIframeEmbeds(`<iframe src="javascript:alert(1)"></iframe>`)).toEqual([
      { kind: "text", text: "javascript:alert(1)" },
    ]);
    expect(parseIframeEmbeds(`<iframe src=www.google.com>`)).toEqual([{ kind: "text", text: "www.google.com" }]);
  });

  it("keeps only the src and sizing, decoding entities", () => {
    const [embed] = parseIframeEmbeds(
      `<iframe width="560" height="315" src="https://www.youtube.com/embed/a?start=3&amp;t=1" onload="alert(1)" srcdoc="<b>x</b>"></iframe>`,
    );
    expect(embed).toEqual({
      kind: "embed",
      src: "https://www.youtube.com/embed/a?start=3&t=1",
      title: "youtube.com",
      aspectRatio: 560 / 315,
      height: null,
      maxWidth: 560,
    });
  });

  it("sizes full-width players by height and responsive wrappers by their padding", () => {
    const [podcast] = parseIframeEmbeds(
      `<iframe src="https://player.bcast.fm/macro-n-cheese/1n3v5418" frameborder="0" height="180" style="width:100%;height:180px;" width="100%"></iframe>`,
    );
    expect(podcast).toMatchObject({ kind: "embed", aspectRatio: null, height: 180 });
    const [loom] = parseIframeEmbeds(
      `<div style="position: relative; padding-bottom: 50%; height: 0;"><iframe src="https://www.loom.com/embed/x" style="position: absolute; width: 100%; height: 100%;"></iframe></div>`,
    );
    expect(loom).toMatchObject({ kind: "embed", aspectRatio: 2 });
  });
});

describe("iframe round-trip in the editor", () => {
  const roundTrip = (markdown: string) => {
    const editor = new Editor({
      extensions: [StarterKit, RawIframeBlock, RawIframeInline, Markdown.configure({ html: true, tightLists: true, bulletListMarker: "-" })],
      content: markdown,
    });
    try {
      return (editor.storage.markdown as { getMarkdown(): string }).getMarkdown();
    } finally { editor.destroy(); }
  };

  it("keeps iframes inside blockquotes and list items verbatim", () => {
    const frame = `<iframe width="560" height="315" src="https://www.youtube.com/embed/ZtqBQ68cfJc" title="YouTube video player" frameborder="0" allowfullscreen></iframe>`;
    expect(roundTrip(`> ${frame}`)).toBe(`> ${frame}`);
    expect(roundTrip(`- item ${frame} after`)).toBe(`- item ${frame} after`);
  });

  it("does not take over other raw HTML", () => {
    expect(roundTrip("Before\n\n<div>plain</div>\n\nAfter")).not.toContain("data-raw-iframe");
  });
});
