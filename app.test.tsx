// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import {
  CHAT_WIKILINK_HOVER_EVENT,
  CHAT_WIKILINK_OPEN_EVENT,
  type ChatWikilinkHoverDetail,
  type ChatWikilinkOpenDetail,
} from "./chat-wikilinks.js";
import {
  COMPOSER_WIKILINK_QUERY_EVENT,
  COMPOSER_WIKILINK_RESULTS_EVENT,
  type ComposerWikilinkResultsDetail,
} from "./composer-autocomplete.js";

// Node 25 ships its own experimental `localStorage` global that shadows
// jsdom's Storage under vitest; stub a real in-memory one for the
// backlinks-in-document tests so they behave the same on every Node.
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
}

describe("Wikilinks preview", () => {
  it("finishes opening a different note even when focus refresh runs during the read", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const Opener = app.fileOpeners[0]!.component;
    const source = { kind: "workspace" as const, threadId: "switch-thread", environmentId: "switch-env", projectId: null };
    let finish!: (value: { content: string; sha256: string }) => void;
    const refresh = vi.fn((input) => ({ changed: false, sha256: input.knownSha256 }));
    const props = { path: "Switch-first.md", source, Original: () => <div>Original preview</div> };
    const slot = renderSlot(app.fileOpeners[0]!, props, { rpc: {
      open_markdown: (input) => (input as { path: string }).path === props.path
        ? { content: "# First switch note", sha256: "first-sha" }
        : new Promise<{ content: string; sha256: string }>((resolve) => { finish = resolve; }),
      refresh_markdown: refresh,
      resolve_markdown_links: () => ({ links: [] }),
    } });
    try {
      await slot.findByText("First switch note");
      slot.lifecycle.rerender(<Opener {...props} path="Switch-second.md" />);
      await slot.findByText("Loading Markdown…");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await act(async () => finish({ content: "# Second switch note", sha256: "second-sha" }));
      await slot.findByText("Second switch note");
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      slot.lifecycle.unmount();
    }
  });


  it("registers for Markdown and opens an aliased wikilink through BB navigation", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    expect(opener).toMatchObject({
      id: "obsidian-wikilinks",
      title: "Wikilinks live editor",
      extensions: ["md", "markdown"],
    });

    const slot = renderSlot(
      opener,
      {
        path: "notes/Current.md",
        source: {
          kind: "workspace",
          threadId: "thread-1",
          environmentId: "env-1",
          projectId: "project-1",
        },
        Original: () => <div>Original preview</div>,
      },
      {
        rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
          open_markdown: () => ({
            content:
              "Read [[Strategy|the strategy]] and [Continual learning.md](/workspace/Continual%20learning.md).",
            sha256: "current-sha",
          }),
          resolve_markdown_links: () => ({
            links: [
              {
                reference: "Strategy",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-1",
                  path: "notes/Strategy.md",
                },
                exists: true,
              },
              {
                reference: "/workspace/Continual learning.md",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-1",
                  path: "Continual learning.md",
                },
                exists: true,
              },
            ],
          }),
          preview_file: (input) =>
            (input as { target: { path: string } }).target.path ===
            "Continual learning.md"
              ? {
                  content:
                    "# Preview heading\n\nRendered **Markdown** with [Details.md](notes/Details.md).",
                  imageDataUrl: null,
                  backlinks: null,
                  truncated: false,
                  links: [
                    {
                      reference: "notes/Details.md",
                      target: {
                        kind: "workspace" as const,
                        environmentId: "env-1",
                        path: "notes/Details.md",
                      },
                      exists: true,
                    },
                  ],
                }
              : {
                  content: "# Details\n\nA recursively rendered preview.",
                  imageDataUrl: null,
                  backlinks: null,
                  truncated: false,
                  links: [],
                },
        },
      },
    );

    const link = await slot.findByRole("link", { name: "the strategy" });
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: {
        target: {
          kind: "workspace",
          environmentId: "env-1",
          path: "notes/Strategy.md",
        },
        location: null,
      },
    });
    const markdownLink = await slot.findByRole("link", {
      name: "Continual learning.md",
    });
    fireEvent.click(markdownLink);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: {
        target: {
          kind: "workspace",
          environmentId: "env-1",
          path: "Continual learning.md",
        },
        location: null,
      },
    });
    fireEvent.pointerEnter(markdownLink);
    await waitFor(() => {
      expect(
        document.body.querySelector('[data-wikilink-hover-preview] h1')
          ?.textContent,
      ).toBe("Preview heading");
    });
    const parentCard = document.body.querySelector<HTMLElement>(
      "[data-wikilink-hover-preview]",
    )!;
    const nestedLink = parentCard.querySelector<HTMLAnchorElement>(
      "a.wikilink",
    )!;
    expect(nestedLink.textContent).toBe("Details.md");
    fireEvent.pointerEnter(nestedLink);
    await waitFor(() => {
      const cards = document.body.querySelectorAll<HTMLElement>(
        "[data-wikilink-hover-preview]",
      );
      expect(cards).toHaveLength(2);
      expect(cards[0]!.contains(cards[1]!)).toBe(true);
      expect(cards[1]!.querySelector("h1")?.textContent).toBe("Details");
    });
    slot.lifecycle.unmount();
  }, 15_000);

  it("live-updates an open Markdown preview when the file changes on disk", async () => {
    let refreshCalls = 0;
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    const slot = renderSlot(
      opener,
      {
        path: "notes/Changing.md",
        source: {
          kind: "workspace",
          threadId: "thread-changing",
          environmentId: "env-changing",
          projectId: "project-changing",
        },
        Original: () => <div>Original preview</div>,
      },
      {
        rpc: {
          open_markdown: () => ({
            content: "# Before the agent edit",
            sha256: "before-sha",
          }),
          refresh_markdown: () => {
            refreshCalls += 1;
            return {
              changed: true as const,
              content: "# After the agent edit\n\nThe preview refreshed.",
              sha256: "after-sha",
            };
          },
          resolve_markdown_links: () => ({ links: [] }),
        },
      },
    );

    expect(
      await slot.findByRole("heading", { name: "Before the agent edit" }),
    ).not.toBeNull();
    expect(
      await slot.findByRole(
        "heading",
        { name: "After the agent edit" },
        { timeout: 2_500 },
      ),
    ).not.toBeNull();
    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    expect(await slot.findAllByText("The preview refreshed.")).not.toHaveLength(0);
    slot.lifecycle.unmount();
  }, 15_000);

  it("keeps one refresh in flight across repeated focus events", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    let finish!: (value: { changed: true; content: string; sha256: string }) => void;
    const refresh = vi.fn(() => new Promise<{ changed: true; content: string; sha256: string }>((resolve) => { finish = resolve; }));
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: "Focus-refresh.md",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
      Original: () => <div>Original</div>,
    }, { rpc: {
      open_markdown: () => ({ content: "# Focus baseline", sha256: "old" }),
      refresh_markdown: refresh,
      resolve_markdown_links: () => ({ links: [] }),
    } });
    try {
      await slot.findByRole("heading", { name: "Focus baseline" });
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      fireEvent.focus(window);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      fireEvent.focus(window);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(refresh).toHaveBeenCalledTimes(1);
      await act(async () => { finish({ changed: true, content: "# Focus updated", sha256: "new" }); });
      fireEvent.click(await slot.findByRole("heading", { name: "Focus updated" }));
      const editor = await slot.findByRole("textbox");
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
      await act(async () => { finish({ changed: true, content: "# Clean editor updated", sha256: "newer" }); });
      await waitFor(() => expect(editor.textContent).toContain("Clean editor updated"));
      expect(slot.inspection.rpcCalls.some((call) => call.method === "save_markdown")).toBe(false);
    } finally { slot.lifecycle.unmount(); }
  });

  it("shows refresh failure and recovers without changing tabs, including unchanged reads", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    let failed = true;
    let changed = false;
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: "Retry-refresh.md",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
      Original: () => <div>Original</div>,
    }, { rpc: {
      open_markdown: () => ({ content: "# Retry baseline", sha256: "old" }),
      refresh_markdown: () => {
        if (failed) throw new Error("HTTP 504: Timed out waiting for command result");
        return changed ? { changed: true, content: "# Retry updated", sha256: "new" }
          : { changed: false, sha256: "old" };
      },
      resolve_markdown_links: () => ({ links: [] }),
    } });
    try {
      await slot.findByRole("heading", { name: "Retry baseline" });
      await slot.findByText("Live updates interrupted. Retrying…");
      failed = false;
      await waitFor(() => expect(slot.queryByText("Live updates interrupted. Retrying…")).toBeNull());
      changed = true;
      await slot.findByRole("heading", { name: "Retry updated" });
    } finally { slot.lifecycle.unmount(); }
  });

  it("protects unsaved editor text when an external refresh arrives during editing", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    let finish!: (value: { changed: true; content: string; sha256: string }) => void;
    const refresh = vi.fn(() => new Promise<{ changed: true; content: string; sha256: string }>((resolve) => { finish = resolve; }));
    const save = vi.fn(() => ({ outcome: "conflict", currentSha256: "external" }));
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: "Dirty-refresh.md",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
      Original: () => <div>Original</div>,
    }, { rpc: {
      open_markdown: () => ({ content: "# Dirty baseline", sha256: "old" }),
      refresh_markdown: refresh,
      resolve_markdown_links: () => ({ links: [] }),
      save_markdown: save,
    } });
    try {
      fireEvent.click(await slot.findByRole("heading", { name: "Dirty baseline" }));
      const editor = await slot.findByRole("textbox");
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      editor.blur();
      const heading = editor.querySelector("h1")!;
      heading.textContent = "My unsaved text";
      fireEvent.input(heading);
      await waitFor(() => expect(slot.queryByText("Unsaved changes")).not.toBeNull());
      await act(async () => { finish({ changed: true, content: "# External text", sha256: "external" }); });
      await slot.findByText("This note changed on disk.");
      expect(editor.textContent).toContain("My unsaved text");
      expect(editor.textContent).not.toContain("External text");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    } finally { slot.lifecycle.unmount(); }
  }, 15_000);

  it("merges an external change into unsaved edits instead of blocking on the banner", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const base = "# Merge baseline\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const external = `${base}\nAppended by an agent.\n`;
    let finish!: (value: { changed: true; content: string; sha256: string }) => void;
    const refresh = vi.fn(() => new Promise<{ changed: true; content: string; sha256: string }>((resolve) => { finish = resolve; }));
    const saves: Array<Record<string, unknown>> = [];
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: "Merge-refresh.md",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
      Original: () => <div>Original</div>,
    }, { rpc: {
      open_markdown: () => ({ content: base, sha256: "old" }),
      refresh_markdown: refresh,
      resolve_markdown_links: () => ({ links: [] }),
      save_markdown: (input) => {
        saves.push(input as unknown as Record<string, unknown>);
        return { outcome: "written" as const, sha256: "merged-sha" };
      },
    } });
    try {
      fireEvent.click(await slot.findByRole("heading", { name: "Merge baseline" }));
      const editor = await slot.findByRole("textbox");
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      editor.blur();
      const heading = editor.querySelector("h1")!;
      heading.textContent = "Merge mine";
      fireEvent.input(heading);
      await waitFor(() => expect(slot.queryByText("Unsaved changes")).not.toBeNull());
      await act(async () => { finish({ changed: true, content: external, sha256: "external" }); });
      await waitFor(() => expect(editor.textContent).toContain("Appended by an agent."));
      expect(editor.textContent).toContain("Merge mine");
      expect(slot.queryByText("This note changed on disk.")).toBeNull();
      await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2500 });
      expect(saves[0]).toMatchObject({
        content: "# Merge mine\n\nFirst paragraph.\n\nSecond paragraph.\n\nAppended by an agent.\n",
        expectedSha256: "external",
      });
      expect(await slot.findByText("Saved")).not.toBeNull();
    } finally { slot.lifecycle.unmount(); }
  }, 15_000);

  it("renders allowlisted iframes and saves edited notes with the iframe markup byte-for-byte", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const youtube = `<iframe width="560" height="315" src="https://www.youtube.com/embed/_IbTZBMHkmE?start=3622" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    const loom = `<div style="position: relative; padding-bottom: 67.66917293233082%; height: 0;"><iframe src="https://www.loom.com/embed/4c1799d671f04c11810775d8df4783ed" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe></div>`;
    const inline = `See this file <iframe style="border: 1px solid rgba(0, 0, 0, 0.1);" width="800" height="450" src="https://www.figma.com/embed?embed_host=share&url=https%3A%2F%2Fwww.figma.com%2Ffile%2FOmKH" allowfullscreen></iframe> for parens.`;
    const blocked = `<iframe src="https://aphyr.com/posts/302-clojure-from-the-ground-up-basic-types"></iframe>`;
    const base = `---\nstatus: done\n---\n# Video note\n\n${youtube}\n\nFirst paragraph.\n\n${loom}\n\n${inline}\n\n${blocked}\n`;
    const saves: Array<Record<string, unknown>> = [];
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: "Iframe-note.md",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
      Original: () => <div>Original</div>,
    }, { rpc: {
      open_markdown: () => ({ content: base, sha256: "old" }),
      refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
      resolve_markdown_links: () => ({ links: [] }),
      save_markdown: (input) => {
        saves.push(input as unknown as Record<string, unknown>);
        return { outcome: "written" as const, sha256: "saved-sha" };
      },
    } });
    try {
      const heading = await slot.findByRole("heading", { name: "Video note" });
      const preview = heading.closest(".wikilinks-rendered-markdown")!;
      const frames = Array.from(preview.querySelectorAll("iframe"));
      expect(frames.map((frame) => new URL(frame.src).hostname)).toEqual(["www.youtube.com", "www.loom.com", "www.figma.com"]);
      expect(frames[0]!.getAttribute("sandbox")).toContain("allow-scripts");
      expect(frames[0]!.src).toBe("https://www.youtube.com/embed/_IbTZBMHkmE?start=3622");
      expect((frames[0]!.parentElement as HTMLElement).style.aspectRatio).toMatch(/^1\.777/);
      expect(preview.textContent).not.toContain("<iframe");
      expect(preview.textContent).toContain("aphyr.com/posts/302-clojure-from-the-ground-up-basic-types");

      fireEvent.click(heading);
      const editor = await slot.findByRole("textbox");
      expect(Array.from(editor.querySelectorAll("iframe")).map((frame) => new URL(frame.src).hostname))
        .toEqual(["www.youtube.com", "www.loom.com", "www.figma.com"]);
      expect(editor.textContent).not.toContain("<iframe");
      const title = editor.querySelector("h1")!;
      title.textContent = "Video notes, edited";
      fireEvent.input(title);
      await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2500 });
      // The editor drops a note's final newline on save for every note; everything else is kept.
      expect(saves[0]!.content).toBe(base.replace("# Video note", "# Video notes, edited").replace(/\n$/, ""));
      for (const markup of [youtube, loom, inline, blocked]) expect(saves[0]!.content).toContain(markup);
    } finally { slot.lifecycle.unmount(); }
  }, 15_000);

  it("merges the file's newer copy when a save hits a conflict", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const base = "# Conflict baseline\n\nBody.\n";
    const external = `${base}\nAgent line.\n`;
    let fileSha = "old";
    const saves: Array<Record<string, unknown>> = [];
    const slot = renderSlot(app.fileOpeners[0]!, {
      path: "Save-conflict.md",
      source: { kind: "host", threadId: null, environmentId: null, projectId: null },
      Original: () => <div>Original</div>,
    }, { rpc: {
      open_markdown: () => ({ content: base, sha256: "old" }),
      refresh_markdown: (input) => {
        const known = (input as { knownSha256: string }).knownSha256;
        // Polls do not notice the agent's write until our save has collided with it.
        if (saves.length === 0 || known === fileSha) {
          return { changed: false as const, sha256: known };
        }
        return { changed: true as const, content: external, sha256: fileSha };
      },
      resolve_markdown_links: () => ({ links: [] }),
      save_markdown: (input) => {
        const request = input as { content: string; expectedSha256?: string };
        saves.push(request as unknown as Record<string, unknown>);
        if (request.expectedSha256 !== fileSha) {
          return { outcome: "conflict" as const, currentSha256: fileSha };
        }
        fileSha = "written";
        return { outcome: "written" as const, sha256: fileSha };
      },
    } });
    try {
      fireEvent.click(await slot.findByRole("heading", { name: "Conflict baseline" }));
      const editor = await slot.findByRole("textbox");
      // The agent writes between the last poll and our save.
      fileSha = "external";
      editor.blur();
      const heading = editor.querySelector("h1")!;
      heading.textContent = "Conflict mine";
      fireEvent.input(heading);
      await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
      expect(saves[0]).toMatchObject({ expectedSha256: "old" });
      expect(saves[1]).toMatchObject({
        content: "# Conflict mine\n\nBody.\n\nAgent line.\n",
        expectedSha256: "external",
      });
      await waitFor(() => expect(editor.textContent).toContain("Agent line."));
      expect(editor.textContent).toContain("Conflict mine");
      expect(slot.queryByText("This note changed on disk.")).toBeNull();
      expect(await slot.findByText("Saved")).not.toBeNull();
    } finally { slot.lifecycle.unmount(); }
  }, 15_000);

  it("restores unsaved text, editing mode and the caret from a draft after a remount", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    try {
      const app = await loadPluginApp(() => import("./app.js"));
      const source = { kind: "host" as const, threadId: null, environmentId: null, projectId: null };
      const base = "# Draft baseline\n\nBody.\n";
      const draftMarkdown = "# Draft restored\n\nBody.";
      storage.setItem(
        `wikilinks:editor-draft:${JSON.stringify(["Draft-restore.md", source])}`,
        JSON.stringify({ baseSha: "old", base, markdown: draftMarkdown, editing: true, selection: { from: 5, to: 5 }, at: Date.now() }),
      );
      const saves: Array<Record<string, unknown>> = [];
      const slot = renderSlot(app.fileOpeners[0]!, {
        path: "Draft-restore.md",
        source,
        Original: () => <div>Original</div>,
      }, { rpc: {
        open_markdown: () => ({ content: base, sha256: "old" }),
        refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
        resolve_markdown_links: () => ({ links: [] }),
        save_markdown: (input) => {
          saves.push(input as unknown as Record<string, unknown>);
          return { outcome: "written" as const, sha256: "draft-saved" };
        },
      } });
      try {
        const editor = await slot.findByRole("textbox");
        await waitFor(() => expect(editor.textContent).toContain("Draft restored"));
        expect(await slot.findByText("Editing")).not.toBeNull();
        await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2500 });
        expect(saves[0]).toMatchObject({ content: draftMarkdown, expectedSha256: "old" });
        await waitFor(() => expect(storage.length).toBe(0));
        expect(await slot.findByText("Saved")).not.toBeNull();
      } finally { slot.lifecycle.unmount(); }
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("parks unsaved text as a draft while editing and merges it when the file moved on before the remount", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
    try {
      const app = await loadPluginApp(() => import("./app.js"));
      const source = { kind: "host" as const, threadId: null, environmentId: null, projectId: null };
      const key = `wikilinks:editor-draft:${JSON.stringify(["Draft-park.md", source])}`;
      const base = "# Park baseline\n\nBody.\n";
      const slot = renderSlot(app.fileOpeners[0]!, {
        path: "Draft-park.md",
        source,
        Original: () => <div>Original</div>,
      }, { rpc: {
        open_markdown: () => ({ content: base, sha256: "old" }),
        refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
        resolve_markdown_links: () => ({ links: [] }),
        save_markdown: () => new Promise<never>(() => {}),
      } });
      try {
        fireEvent.click(await slot.findByRole("heading", { name: "Park baseline" }));
        const editor = await slot.findByRole("textbox");
        editor.blur();
        const heading = editor.querySelector("h1")!;
        heading.textContent = "Park mine";
        fireEvent.input(heading);
        await waitFor(() => expect(storage.getItem(key)).not.toBeNull());
        const draft = JSON.parse(storage.getItem(key)!) as { markdown: string; base: string; baseSha: string };
        expect(draft).toMatchObject({ base, baseSha: "old", markdown: "# Park mine\n\nBody." });
      } finally { slot.lifecycle.unmount(); }

      // The bundle reloads and an agent appended to the file meanwhile.
      const saves: Array<Record<string, unknown>> = [];
      const remounted = renderSlot(app.fileOpeners[0]!, {
        path: "Draft-park.md",
        source,
        Original: () => <div>Original</div>,
      }, { rpc: {
        open_markdown: () => ({ content: `${base}\nAgent line.\n`, sha256: "external" }),
        refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
        resolve_markdown_links: () => ({ links: [] }),
        save_markdown: (input) => {
          saves.push(input as unknown as Record<string, unknown>);
          return { outcome: "written" as const, sha256: "merged" };
        },
      } });
      try {
        const editor = await remounted.findByRole("textbox");
        await waitFor(() => expect(editor.textContent).toContain("Park mine"));
        expect(editor.textContent).toContain("Agent line.");
        await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2500 });
        expect(saves[0]).toMatchObject({
          content: "# Park mine\n\nBody.\n\nAgent line.\n",
          expectedSha256: "external",
        });
        await waitFor(() => expect(storage.getItem(key)).toBeNull());
      } finally { remounted.lifecycle.unmount(); }
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("autosaves rich-preview edits back to the live Markdown file", async () => {
    const saves: Array<Record<string, unknown>> = [];
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    const slot = renderSlot(
      opener,
      {
        path: "notes/Editable.md",
        source: {
          kind: "workspace",
          threadId: "thread-edit",
          environmentId: "env-edit",
          projectId: "project-edit",
        },
        Original: () => <div>Original preview</div>,
      },
      {
        rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
          open_markdown: () => ({
            content:
              "---\ntitle: Editable\n---\n\n# Original heading\n\nSee [[Strategy|the plan]].\n",
            sha256: "old-sha",
          }),
          resolve_markdown_links: () => ({ links: [] }),
          save_markdown: (input) => {
            saves.push(input as unknown as Record<string, unknown>);
            return {
              outcome: "written" as const,
              sha256: "next-sha",
            };
          },
        },
      },
    );

    const previewHeading = await slot.findByRole("heading", {
      name: "Original heading",
    });
    fireEvent.click(previewHeading);
    const editor = await slot.findByRole("textbox");
    const heading = editor.querySelector("h1")!;
    heading.textContent = "Updated heading";
    fireEvent.input(heading);

    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 2500 });
    expect(saves[0]).toMatchObject({
      path: "notes/Editable.md",
      content:
        "---\ntitle: Editable\n---\n\n# Updated heading\n\nSee [[Strategy|the plan]].",
      expectedSha256: "old-sha",
    });
    expect(await slot.findByText("Saved")).not.toBeNull();
    slot.lifecycle.unmount();
  }, 15_000);

  it("shows a zoom-to-fit tldraw thumbnail from an ordinary Markdown link", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    const slot = renderSlot(
      opener,
      {
        path: "notes/Current.md",
        source: {
          kind: "workspace",
          threadId: "thread-canvas",
          environmentId: "env-canvas",
          projectId: "project-canvas",
        },
        Original: () => <div>Original preview</div>,
      },
      {
        rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
          open_markdown: () => ({
            content:
              "See [the pitch canvas](websim/I-%20Prompt%20arenas%20into%20existence%20(whiteboard).tldraw).",
            sha256: "canvas-note-sha",
          }),
          resolve_markdown_links: () => ({
            links: [
              {
                reference:
                  "websim/I- Prompt arenas into existence (whiteboard).tldraw",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-canvas",
                  path: "websim/I- Prompt arenas into existence (whiteboard).tldraw",
                },
                exists: true,
              },
            ],
          }),
          preview_file: () => ({
            content: null,
            imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
            backlinks: null,
            truncated: false,
            links: [],
          }),
        },
      },
    );

    const link = await slot.findByRole("link", { name: "the pitch canvas" });
    fireEvent.pointerEnter(link);
    await waitFor(() => {
      expect(
        document.body.querySelector<HTMLImageElement>(
          'img[alt="Canvas preview of I- Prompt arenas into existence (whiteboard)"]',
        )?.src,
      ).toBe("data:image/png;base64,iVBORw0KGgo=");
    });
    slot.lifecycle.unmount();
  });

  it("shows contextual backlinks and heading breadcrumbs on command hover", async () => {
    const previewCalls: unknown[] = [];
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    const slot = renderSlot(
      opener,
      {
        path: "notes/Current.md",
        source: {
          kind: "workspace",
          threadId: "thread-backlinks",
          environmentId: "env-backlinks",
          projectId: "project-backlinks",
        },
        Original: () => <div>Original preview</div>,
      },
      {
        rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
          open_markdown: () => ({
            content: "See [[Target]].",
            sha256: "backlink-note-sha",
          }),
          resolve_markdown_links: () => ({
            links: [
              {
                reference: "Target",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-backlinks",
                  path: "notes/Target.md",
                },
                exists: true,
              },
            ],
          }),
          preview_file: (input) => {
            previewCalls.push(input);
            const request = input as {
              target: { path: string };
              backlinks?: boolean;
            };
            if (request.target.path === "notes/Related.md") {
              if (request.backlinks) {
                return {
                  content: null,
                  imageDataUrl: null,
                  backlinks: [
                    {
                      sourceTitle: "Second source",
                      headings: ["Connections"],
                      context: "Second-order backlinks work here too.",
                      target: {
                        kind: "workspace" as const,
                        environmentId: "env-backlinks",
                        path: "notes/Second source.md",
                      },
                      links: [],
                    },
                  ],
                  truncated: false,
                  links: [],
                };
              }
              return {
                content: "# Related preview\n\nThe recursive note preview.",
                imageDataUrl: null,
                backlinks: null,
                truncated: false,
                links: [],
              };
            }
            return {
              content: null,
              imageDataUrl: null,
              backlinks: [
                {
                  sourceTitle: "Source note",
                  headings: ["Research", "Useful angle"],
                  context: "This is why [[Target]] matters alongside [[Related]].",
                  target: {
                    kind: "workspace" as const,
                    environmentId: "env-backlinks",
                    path: "notes/Source note.md",
                  },
                  links: [
                    {
                      reference: "Target",
                      target: {
                        kind: "workspace" as const,
                        environmentId: "env-backlinks",
                        path: "notes/Target.md",
                      },
                      exists: true,
                    },
                    {
                      reference: "Related",
                      target: {
                        kind: "workspace" as const,
                        environmentId: "env-backlinks",
                        path: "notes/Related.md",
                      },
                      exists: true,
                    },
                  ],
                },
              ],
              truncated: false,
              links: [],
            };
          },
        },
      },
    );

    const link = await slot.findByRole("link", { name: "Target" });
    fireEvent.pointerEnter(link, { metaKey: true });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Contextual backlinks");
      expect(document.body.textContent).toContain("Research › Useful angle");
      expect(document.body.textContent).toContain(
        "This is why Target matters alongside Related.",
      );
    });
    expect(previewCalls).toContainEqual(
      expect.objectContaining({ backlinks: true }),
    );
    const parentCard = document.body.querySelector<HTMLElement>(
      "[data-wikilink-hover-preview]",
    )!;
    fireEvent.pointerLeave(link);
    fireEvent.pointerEnter(parentCard);
    const relatedLink = Array.from(
      parentCard.querySelectorAll<HTMLAnchorElement>("a.wikilink"),
    ).find((candidate) => candidate.textContent === "Related")!;
    fireEvent.pointerEnter(relatedLink);
    await waitFor(() => {
      expect(parentCard.querySelector("h1")?.textContent).toBe(
        "Related preview",
      );
    });
    fireEvent.keyDown(window, { key: "Meta" });
    await waitFor(() => {
      expect(parentCard.textContent).toContain("Second-order backlinks work here too.");
    });
    expect(previewCalls).toContainEqual({
      target: {
        kind: "workspace",
        environmentId: "env-backlinks",
        path: "notes/Related.md",
      },
      backlinks: true,
    });
    fireEvent.keyUp(window, { key: "Meta" });
    slot.lifecycle.unmount();
  });

  it("decorates chat wikilinks and restores the original Markdown on cleanup", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    document.body.innerHTML = `
      <div data-thread-window data-wikilinks-bridge-id="bridge-1">
        <div data-markdown-preview>
          <p>Read [[folder/Note|the note]] and ![[Diagram]].</p>
          <p><a class="existing-link" title="Original title" href="/Users/me/Notes/Continual%20learning.md">Continual learning.md</a></p>
          <p><a href="websim/I-%20Prompt%20arenas%20into%20existence%20(whiteboard).tldraw">the arenas whiteboard</a></p>
          <p><a class="web-link" href="https://example.com/essay">Example essay</a></p>
          <pre><code>[[Code sample]]</code></pre>
        </div>
      </div>
    `;
    const opened: ChatWikilinkOpenDetail[] = [];
    const hovered: ChatWikilinkHoverDetail[] = [];
    const onOpen = (event: Event) => {
      opened.push((event as CustomEvent<ChatWikilinkOpenDetail>).detail);
    };
    const onHover = (event: Event) => {
      hovered.push((event as CustomEvent<ChatWikilinkHoverDetail>).detail);
    };
    window.addEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    window.addEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);

    const scripts = await mountPluginContentScripts(app, {
      pluginId: "wikilinks",
    });
    const link = document.body.querySelector<HTMLAnchorElement>(
      "a.wikilink-chat",
    );
    expect(link?.textContent).toBe("the note");
    expect(link?.dataset.wikilinkReference).toBe("folder/Note");
    expect(document.body.textContent).toContain("![[Diagram]]");
    expect(document.body.textContent).toContain("[[Code sample]]");
    const markdownLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href="/Users/me/Notes/Continual%20learning.md"]',
    );
    expect(markdownLink?.classList.contains("wikilink-chat")).toBe(true);
    expect(markdownLink?.dataset.wikilinkReference).toBe(
      "/Users/me/Notes/Continual learning.md",
    );
    const tldrawLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href="websim/I-%20Prompt%20arenas%20into%20existence%20(whiteboard).tldraw"]',
    );
    expect(tldrawLink?.classList.contains("wikilink-chat")).toBe(true);
    expect(tldrawLink?.dataset.wikilinkReference).toBe(
      "websim/I- Prompt arenas into existence (whiteboard).tldraw",
    );
    const webLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com/essay"]',
    );
    expect(webLink?.classList.contains("wikilink-chat")).toBe(true);
    expect(webLink?.dataset.wikilinkReference).toBe(
      "https://example.com/essay",
    );
    expect(webLink?.dataset.wikilinkKind).toBe("web");

    fireEvent.click(link!);
    expect(opened).toEqual([
      { bridgeId: "bridge-1", reference: "folder/Note" },
    ]);
    fireEvent.pointerOver(link!);
    expect(hovered).toEqual([
      {
        bridgeId: "bridge-1",
        reference: "folder/Note",
        anchor: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    ]);
    fireEvent.keyDown(window, { key: "Meta" });
    expect(hovered.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "folder/Note",
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
      immediate: true,
      backlinks: true,
    });
    fireEvent.keyUp(window, { key: "Meta" });
    fireEvent.click(markdownLink!);
    expect(opened.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "/Users/me/Notes/Continual learning.md",
    });
    fireEvent.pointerOver(markdownLink!);
    expect(hovered.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "/Users/me/Notes/Continual learning.md",
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    fireEvent.pointerOver(tldrawLink!);
    expect(hovered.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "websim/I- Prompt arenas into existence (whiteboard).tldraw",
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    fireEvent.pointerOver(webLink!);
    expect(hovered.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "https://example.com/essay",
      web: true,
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    await scripts.lifecycle.dispose();
    expect(document.body.querySelector("a.wikilink-chat")).toBeNull();
    expect(document.body.textContent).toContain("[[folder/Note|the note]]");
    expect(markdownLink?.isConnected).toBe(true);
    expect(markdownLink?.getAttribute("href")).toBe(
      "/Users/me/Notes/Continual%20learning.md",
    );
    expect(markdownLink?.getAttribute("class")).toBe("existing-link");
    expect(markdownLink?.getAttribute("title")).toBe("Original title");
    expect(markdownLink?.hasAttribute("data-wikilink-reference")).toBe(false);
    expect(tldrawLink?.isConnected).toBe(true);
    expect(tldrawLink?.classList.contains("wikilink-chat")).toBe(false);
    expect(tldrawLink?.hasAttribute("data-wikilink-reference")).toBe(false);
    expect(webLink?.getAttribute("class")).toBe("web-link");
    expect(webLink?.hasAttribute("data-wikilink-reference")).toBe(false);
    expect(webLink?.hasAttribute("data-wikilink-kind")).toBe(false);
    window.removeEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    window.removeEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
    document.body.innerHTML = "";
  });

  it("opens a chat wikilink in BB's native file preview", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const action = app.threadHeaderActions[0]!;
    expect(action).toMatchObject({
      id: "chat-wikilinks-navigation",
      title: "Chat wikilinks navigation",
    });
    const slot = renderSlot(
      action,
      {
        threadId: "thread-1",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        rpc: {
          resolve_chat_wikilink: () => ({
            target: {
              kind: "workspace" as const,
              environmentId: "env-1",
              path: "notes/Strategy.md",
            },
            exists: true,
          }),
        },
      },
    );
    const marker = slot.container.querySelector<HTMLElement>(
      "[data-wikilinks-bridge-marker]",
    );
    const bridgeId = marker?.dataset.wikilinksBridgeMarker;
    expect(bridgeId).toBeTruthy();

    fireEvent(
      window,
      new CustomEvent(CHAT_WIKILINK_OPEN_EVENT, {
        detail: { bridgeId, reference: "Strategy" },
      }),
    );

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "experimental_openFilePreview",
        options: {
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "notes/Strategy.md",
          },
          location: null,
        },
      });
    });
    slot.lifecycle.unmount();
  });

  it("shows rendered Markdown when hovering a chat wikilink", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const action = app.threadHeaderActions[0]!;
    const slot = renderSlot(
      action,
      {
        threadId: "thread-1",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        rpc: {
          preview_chat_wikilink: () => ({
            target: {
              kind: "workspace" as const,
              environmentId: "env-1",
              path: "notes/Strategy.md",
            },
            exists: true,
            content: "# Strategy\n\nA **rendered** excerpt with [[Details]].",
            imageDataUrl: null,
            backlinks: null,
            truncated: false,
            links: [
              {
                reference: "Details",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-1",
                  path: "notes/Details.md",
                },
                exists: true,
              },
            ],
          }),
          preview_file: () => ({
            content: "# Details\n\nNested from the chat preview.",
            imageDataUrl: null,
            backlinks: null,
            truncated: false,
            links: [],
          }),
        },
      },
    );
    const bridgeId = slot.container.querySelector<HTMLElement>(
      "[data-wikilinks-bridge-marker]",
    )?.dataset.wikilinksBridgeMarker;

    fireEvent(
      window,
      new CustomEvent(CHAT_WIKILINK_HOVER_EVENT, {
        detail: {
          bridgeId,
          reference: "Strategy",
          anchor: { top: 20, right: 80, bottom: 40, left: 20 },
          immediate: true,
        },
      }),
    );

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-wikilink-hover-preview] strong')
          ?.textContent,
      ).toBe("rendered");
    });
    expect(document.body.textContent).not.toContain("title: Strategy");
    const parentCard = document.body.querySelector<HTMLElement>(
      "[data-wikilink-hover-preview]",
    )!;
    fireEvent.pointerEnter(
      parentCard.querySelector<HTMLAnchorElement>("a.wikilink")!,
    );
    await waitFor(() => {
      const cards = document.body.querySelectorAll<HTMLElement>(
        "[data-wikilink-hover-preview]",
      );
      expect(cards).toHaveLength(2);
      expect(cards[0]!.contains(cards[1]!)).toBe(true);
      expect(cards[1]!.textContent).toContain("Nested from the chat preview.");
    });
    slot.lifecycle.unmount();
    expect(
      document.body.querySelector("[data-wikilink-hover-preview]"),
    ).toBeNull();
  });

  it("shows a scrollable web excerpt for an internet link in chat", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const action = app.threadHeaderActions[0]!;
    const longTitle =
      "A deliberately long webpage title that should wrap across multiple lines in the hover preview";
    const slot = renderSlot(
      action,
      {
        threadId: "thread-web",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        rpc: {
          preview_url: () => ({
            url: "https://example.com/essay",
            title: longTitle,
            siteName: "example.com",
            content:
              "A **readable** web excerpt with a [next page](/next) inside it.",
            format: "markdown" as const,
            truncated: true,
          }),
        },
        openUrl: () => true,
      },
    );
    const bridgeId = slot.container.querySelector<HTMLElement>(
      "[data-wikilinks-bridge-marker]",
    )?.dataset.wikilinksBridgeMarker;

    fireEvent(
      window,
      new CustomEvent(CHAT_WIKILINK_HOVER_EVENT, {
        detail: {
          bridgeId,
          reference: "https://example.com/essay",
          web: true,
          anchor: { top: 20, right: 80, bottom: 40, left: 20 },
          immediate: true,
        },
      }),
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("A readable web excerpt");
    });
    const card = document.body.querySelector<HTMLElement>(
      "[data-wikilink-hover-preview]",
    )!;
    expect(card.querySelector(".wikilink-hover-title")?.textContent).toBe(
      longTitle,
    );
    expect(card.querySelector(".wikilink-hover-card-body")).not.toBeNull();
    expect(
      card.querySelector<HTMLAnchorElement>(
        'a[href="https://example.com/next"]',
      )?.textContent,
    ).toBe("next page");
    fireEvent.click(card.querySelector<HTMLButtonElement>(".wikilink-hover-open")!);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://example.com/essay",
    });
    slot.lifecycle.unmount();
  });

  it("bridges composer autocomplete searches to the thread workspace", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const action = app.threadHeaderActions[0]!;
    const slot = renderSlot(
      action,
      {
        threadId: "thread-1",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        rpc: {
          autocomplete_wikilinks: (input) =>
            (input as { query: string }).query === "arena prompt"
              ? [
                  {
                    reference: "websim/Prompt arenas",
                    label: "Prompt arenas",
                    directory: "websim/",
                  },
                ]
              : [],
        },
      },
    );
    const bridgeId = slot.container.querySelector<HTMLElement>(
      "[data-wikilinks-bridge-marker]",
    )?.dataset.wikilinksBridgeMarker;
    let result: ComposerWikilinkResultsDetail | null = null;
    const onResult = (event: Event) => {
      result = (event as CustomEvent<ComposerWikilinkResultsDetail>).detail;
    };
    window.addEventListener(COMPOSER_WIKILINK_RESULTS_EVENT, onResult);

    fireEvent(
      window,
      new CustomEvent(COMPOSER_WIKILINK_QUERY_EVENT, {
        detail: { bridgeId, requestId: 42, query: "arena prompt" },
      }),
    );
    await waitFor(() => {
      expect(result).toEqual({
        bridgeId,
        requestId: 42,
        suggestions: [
          {
            reference: "websim/Prompt arenas",
            label: "Prompt arenas",
            directory: "websim/",
          },
        ],
      });
    });

    window.removeEventListener(COMPOSER_WIKILINK_RESULTS_EVENT, onResult);
    slot.lifecycle.unmount();
  });

  it("renders backlinks in the document from the vault-graph plugin", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const fetchBodies: Array<{ url: string; body: unknown }> = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchBodies.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      if (url.endsWith("/api/v1/plugins/vault-graph/rpc/resolve_target")) {
        return json(200, {
          ok: true,
          result: {
            inVault: true,
            path: "Structured entropy.md",
            title: "Structured entropy",
            entityId: 7,
          },
        });
      }
      if (url.endsWith("/api/v1/plugins/vault-graph/rpc/note_panel")) {
        return json(200, {
          ok: true,
          result: {
            title: "Structured entropy",
            path: "Structured entropy.md",
            kind: "note",
            entityId: 7,
            backlinks: [
              {
                sourceKind: "note",
                sourceTitle: "Agent society",
                sourcePath: "Agent society.md",
                threadId: null,
                heading: "Agent society",
                context:
                  "The agents need [[Structured entropy|structured sources of difference]] and [[Inter-run learning|shared memory]].",
                line: 20,
                linkKind: "wikilink",
                target: {
                  kind: "host",
                  hostId: "host_1",
                  path: "/vault/Agent society.md",
                },
              },
              {
                sourceKind: "canvas",
                sourceTitle: "Ideas board",
                sourcePath: "Ideas board.tldraw",
                threadId: null,
                heading: "Ideas board > Mutation sticky",
                context: "[[Structured entropy]] seeds variation",
                line: null,
                linkKind: "wikilink",
                target: {
                  kind: "host",
                  hostId: "host_1",
                  path: "/vault/Ideas board.tldraw",
                },
              },
              {
                sourceKind: "thread",
                sourceTitle: "agent societies",
                sourcePath: null,
                threadId: "thr_1",
                heading: null,
                context: "",
                line: null,
                linkKind: "wikilink",
                target: null,
              },
            ],
            unlinked: [
              {
                sourceTitle: "Novelty search",
                sourcePath: "Novelty search.md",
                snippet: "structured entropy shows up without a link",
                target: {
                  kind: "host",
                  hostId: "host_1",
                  path: "/vault/Novelty search.md",
                },
              },
            ],
            outgoing: [],
            tags: [],
            props: {},
          },
        });
      }
      return json(404, { ok: false, error: `unknown route ${url}` });
    });
    try {
      const app = await loadPluginApp(() => import("./app.js"));
      const opener = app.fileOpeners[0]!;
      const slot = renderSlot(
        opener,
        {
          path: "Structured entropy.md",
          source: {
            kind: "workspace",
            threadId: "thread-graph",
            environmentId: "env-graph",
            projectId: "project-graph",
          },
          Original: () => <div>Original preview</div>,
        },
        {
          rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
            open_markdown: () => ({
              content: "# Structured entropy\n\nBody.",
              sha256: "graph-sha",
            }),
            resolve_markdown_links: () => ({ links: [] }),
          },
        },
      );

      const section = await waitFor(() => {
        const element = slot.container.querySelector<HTMLElement>(
          'section[aria-label="Backlinks"][data-provider="vault-graph"]',
        );
        expect(element).not.toBeNull();
        return element!;
      });
      expect(fetchBodies[0]).toEqual({
        url: "/api/v1/plugins/vault-graph/rpc/resolve_target",
        body: {
          kind: "workspace",
          path: "Structured entropy.md",
          environmentId: "env-graph",
        },
      });
      expect(fetchBodies[1]?.body).toEqual({ path: "Structured entropy.md" });
      expect(section.textContent).toContain("Linked mentions");
      expect(section.textContent).toContain("Agent society");
      expect(section.textContent).toContain("Ideas board");
      expect(section.textContent).toContain("Ideas board › Mutation sticky");
      expect(section.textContent).toContain("agent societies");
      expect(
        section.querySelector(".wikilinks-document-backlinks-count")?.textContent,
      ).toBe("3");
      const marks = Array.from(section.querySelectorAll("mark")).map(
        (mark) => mark.textContent,
      );
      // Aliased links show their alias, plain links their title (Obsidian style);
      // the raw wikilink is kept in the title attribute.
      expect(marks).toEqual(["structured sources of difference", "Structured entropy"]);
      expect(
        Array.from(section.querySelectorAll("mark")).map((mark) => mark.getAttribute("title")),
      ).toEqual([
        "[[Structured entropy|structured sources of difference]]",
        "[[Structured entropy]]",
      ]);
      // The section is sourced from vault-graph, so the wikilinks fallback stays idle.
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "preview_file" &&
            (call.input as { backlinks?: boolean }).backlinks === true,
        ),
      ).toBe(false);

      fireEvent.click(slot.getByRole("link", { name: "Agent society" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "experimental_openFilePreview",
        options: {
          target: { kind: "host", hostId: "host_1", path: "/vault/Agent society.md" },
          location: null,
        },
      });
      fireEvent.click(slot.getByRole("button", { name: "agent societies" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thr_1",
      });

      expect(section.textContent).not.toContain("Novelty search");
      fireEvent.click(slot.getByRole("button", { name: /Unlinked mentions/ }));
      expect(section.textContent).toContain("Novelty search");
      expect(section.textContent).toContain(
        "structured entropy shows up without a link",
      );

      fireEvent.click(slot.getByRole("button", { name: /Linked mentions/ }));
      expect(section.textContent).not.toContain("Agent society");
      expect(storage.getItem("wikilinks:document-backlinks:collapsed")).toBe("1");
      slot.lifecycle.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to wikilinks' own contextual backlinks when vault-graph is missing", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ ok: false, error: 'unknown plugin "vault-graph"' }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    try {
      const app = await loadPluginApp(() => import("./app.js"));
      const opener = app.fileOpeners[0]!;
      const slot = renderSlot(
        opener,
        {
          path: "notes/Target.md",
          source: {
            kind: "workspace",
            threadId: "thread-fallback",
            environmentId: "env-fallback",
            projectId: "project-fallback",
          },
          Original: () => <div>Original preview</div>,
        },
        {
          rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
            open_markdown: () => ({ content: "# Target", sha256: "target-sha" }),
            resolve_markdown_links: () => ({ links: [] }),
            preview_file: (input) => {
              const request = input as {
                target: { path: string };
                backlinks?: boolean;
              };
              expect(request.target).toEqual({
                kind: "workspace",
                environmentId: "env-fallback",
                path: "notes/Target.md",
              });
              return {
                content: null,
                imageDataUrl: null,
                backlinks: request.backlinks
                  ? [
                      {
                        sourceTitle: "Source note",
                        headings: ["Research", "Useful angle"],
                        context: "This is why [[Target]] matters.",
                        target: {
                          kind: "workspace" as const,
                          environmentId: "env-fallback",
                          path: "notes/Source note.md",
                        },
                        links: [],
                      },
                    ]
                  : null,
                truncated: false,
                links: [],
              };
            },
          },
        },
      );

      const section = await waitFor(() => {
        const element = slot.container.querySelector<HTMLElement>(
          'section[aria-label="Backlinks"][data-provider="wikilinks"]',
        );
        expect(element).not.toBeNull();
        return element!;
      });
      expect(section.textContent).toContain("Source note");
      expect(section.textContent).toContain("Research › Useful angle");
      expect(section.querySelector("mark")?.textContent).toBe("Target");
      expect(section.textContent).not.toContain("Unlinked mentions");
      slot.lifecycle.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides the document backlinks section when the setting is off", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    const slot = renderSlot(
      opener,
      {
        path: "notes/Quiet.md",
        source: {
          kind: "workspace",
          threadId: "thread-quiet",
          environmentId: "env-quiet",
          projectId: "project-quiet",
        },
        Original: () => <div>Original preview</div>,
      },
      {
        settings: { documentBacklinks: false },
        rpc: {
          refresh_markdown: (input) => ({ changed: false, sha256: (input as { knownSha256: string }).knownSha256 }),
          open_markdown: () => ({ content: "# Quiet", sha256: "quiet-sha" }),
          resolve_markdown_links: () => ({ links: [] }),
        },
      },
    );
    await slot.findByRole("heading", { name: "Quiet" });
    expect(slot.container.querySelector('section[aria-label="Backlinks"]')).toBeNull();
    slot.lifecycle.unmount();
  });
});
