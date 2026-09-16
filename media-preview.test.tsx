// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { InstantMarkdownPreview } from "./instant-markdown-preview.js";

describe("Obsidian media embeds", () => {
  it("renders media with spaces and dimensions while keeping code and note embeds literal", () => {
    const slot = render(<InstantMarkdownPreview
      content={'![[Images/chart one.jpg|300]]\n\n![[Images/demo.mp4]]\n\n`![[code.mp4]]`\n\n![[Note]]'}
      renderNoteLink={(_, children) => children} renderUrlLink={(_, children) => children}
      renderMedia={(ref, alias) => <span data-media={ref} data-alias={alias} />}
    />);
    expect(Array.from(slot.container.querySelectorAll('[data-media]')).map(e => [e.getAttribute('data-media'), e.getAttribute('data-alias')])).toEqual([['Images/chart one.jpg','300'],['Images/demo.mp4','']]);
    expect(slot.container.textContent).toContain('![[code.mp4]]');
    expect(slot.container.textContent).toContain('![[Note]]');
    cleanup();
  });
  it("loads images and playable videos in the note preview without entering edit mode", async () => {
    const app = await loadPluginApp(() => import('./app.js'));
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: 'Media.md', source: { kind: 'workspace', threadId: 'media-thread', environmentId: 'media-env', projectId: null }, Original: () => <div>Original</div>
    }, { rpc: {
      open_markdown: () => ({ content: '![[Images/chart.jpg]]\n\n![[Images/demo.mp4]]', sha256: 'media-sha' }),
      refresh_markdown: () => ({ changed: false, sha256: 'media-sha' }),
      resolve_markdown_links: () => ({ links: [] }),
      resolve_media: (input) => ({ url: '/preview/'+(input as { reference: string }).reference, expiresAtMs: Date.now()+3600000 }),
    }});
    try {
      const image = await slot.findByAltText('Images/chart.jpg');
      const video = await slot.findByLabelText('Images/demo.mp4');
      expect(image.getAttribute('src')).toBe('/preview/Images/chart.jpg');
      expect(video.tagName).toBe('VIDEO');
      expect(video.hasAttribute('controls')).toBe(true);
      expect(video.hasAttribute('playsinline')).toBe(true);
      video.click();
      expect(video.closest('[hidden]')).toBeNull();
    } finally { slot.lifecycle.unmount(); }
  });
});
