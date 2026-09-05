// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
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
  it("registers for Markdown and opens an aliased wikilink through BB navigation", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    const opener = app.fileOpeners[0]!;
    expect(opener).toMatchObject({
      id: "obsidian-wikilinks",
      title: "Obsidian at Home",
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
          open_markdown: () => ({
            content:
              "Read [[Strategy|the strategy]] and [Example document.md](/workspace/Example%20document.md).",
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
                reference: "/workspace/Example document.md",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-1",
                  path: "Example document.md",
                },
                exists: true,
              },
            ],
          }),
          preview_file: (input) =>
            (input as { target: { path: string } }).target.path ===
            "Example document.md"
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
      name: "Example document.md",
    });
    fireEvent.click(markdownLink);
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: {
        target: {
          kind: "workspace",
          environmentId: "env-1",
          path: "Example document.md",
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
          open_markdown: () => ({
            content:
              "See [the pitch canvas](examples/Team%20workshops%20(whiteboard).tldraw).",
            sha256: "canvas-note-sha",
          }),
          resolve_markdown_links: () => ({
            links: [
              {
                reference:
                  "examples/Team workshops (whiteboard).tldraw",
                target: {
                  kind: "workspace" as const,
                  environmentId: "env-canvas",
                  path: "examples/Team workshops (whiteboard).tldraw",
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
          'img[alt="Canvas preview of Team workshops (whiteboard)"]',
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
          <p><a class="existing-link" title="Original title" href="/Users/me/Notes/Example%20document.md">Example document.md</a></p>
          <p><a href="examples/Team%20workshops%20(whiteboard).tldraw">the workshop whiteboard</a></p>
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
      'a[href="/Users/me/Notes/Example%20document.md"]',
    );
    expect(markdownLink?.classList.contains("wikilink-chat")).toBe(true);
    expect(markdownLink?.dataset.wikilinkReference).toBe(
      "/Users/me/Notes/Example document.md",
    );
    const tldrawLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href="examples/Team%20workshops%20(whiteboard).tldraw"]',
    );
    expect(tldrawLink?.classList.contains("wikilink-chat")).toBe(true);
    expect(tldrawLink?.dataset.wikilinkReference).toBe(
      "examples/Team workshops (whiteboard).tldraw",
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
      reference: "/Users/me/Notes/Example document.md",
    });
    fireEvent.pointerOver(markdownLink!);
    expect(hovered.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "/Users/me/Notes/Example document.md",
      anchor: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    fireEvent.pointerOver(tldrawLink!);
    expect(hovered.at(-1)).toEqual({
      bridgeId: "bridge-1",
      reference: "examples/Team workshops (whiteboard).tldraw",
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
      "/Users/me/Notes/Example%20document.md",
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
            (input as { query: string }).query === "workshop team"
              ? [
                  {
                    reference: "examples/Team workshops",
                    label: "Team workshops",
                    directory: "examples/",
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
        detail: { bridgeId, requestId: 42, query: "workshop team" },
      }),
    );
    await waitFor(() => {
      expect(result).toEqual({
        bridgeId,
        requestId: 42,
        suggestions: [
          {
            reference: "examples/Team workshops",
            label: "Team workshops",
            directory: "examples/",
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
            path: "Project planning.md",
            title: "Project planning",
            entityId: 7,
          },
        });
      }
      if (url.endsWith("/api/v1/plugins/vault-graph/rpc/note_panel")) {
        return json(200, {
          ok: true,
          result: {
            title: "Project planning",
            path: "Project planning.md",
            kind: "note",
            entityId: 7,
            backlinks: [
              {
                sourceKind: "note",
                sourceTitle: "Team handbook",
                sourcePath: "Team handbook.md",
                threadId: null,
                heading: "Team handbook",
                context:
                  "The team uses [[Project planning|planning checklist]] and [[Weekly review|review notes]].",
                line: 20,
                linkKind: "wikilink",
                target: {
                  kind: "host",
                  hostId: "host_1",
                  path: "/vault/Team handbook.md",
                },
              },
              {
                sourceKind: "canvas",
                sourceTitle: "Ideas board",
                sourcePath: "Ideas board.tldraw",
                threadId: null,
                heading: "Ideas board > Planning sticky",
                context: "[[Project planning]] guides the meeting",
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
                sourceTitle: "team discussion",
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
                sourceTitle: "Meeting notes",
                sourcePath: "Meeting notes.md",
                snippet: "project planning shows up without a link",
                target: {
                  kind: "host",
                  hostId: "host_1",
                  path: "/vault/Meeting notes.md",
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
          path: "Project planning.md",
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
            open_markdown: () => ({
              content: "# Project planning\n\nBody.",
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
          path: "Project planning.md",
          environmentId: "env-graph",
        },
      });
      expect(fetchBodies[1]?.body).toEqual({ path: "Project planning.md" });
      expect(section.textContent).toContain("Linked mentions");
      expect(section.textContent).toContain("Team handbook");
      expect(section.textContent).toContain("Ideas board");
      expect(section.textContent).toContain("Ideas board › Planning sticky");
      expect(section.textContent).toContain("team discussion");
      expect(
        section.querySelector(".wikilinks-document-backlinks-count")?.textContent,
      ).toBe("3");
      const marks = Array.from(section.querySelectorAll("mark")).map(
        (mark) => mark.textContent,
      );
      // Aliased links show their alias, plain links their title (Obsidian style);
      // the raw wikilink is kept in the title attribute.
      expect(marks).toEqual(["planning checklist", "Project planning"]);
      expect(
        Array.from(section.querySelectorAll("mark")).map((mark) => mark.getAttribute("title")),
      ).toEqual([
        "[[Project planning|planning checklist]]",
        "[[Project planning]]",
      ]);
      // The section is sourced from vault-graph, so the wikilinks fallback stays idle.
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "preview_file" &&
            (call.input as { backlinks?: boolean }).backlinks === true,
        ),
      ).toBe(false);

      fireEvent.click(slot.getByRole("link", { name: "Team handbook" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "experimental_openFilePreview",
        options: {
          target: { kind: "host", hostId: "host_1", path: "/vault/Team handbook.md" },
          location: null,
        },
      });
      fireEvent.click(slot.getByRole("button", { name: "team discussion" }));
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "toThread",
        threadId: "thr_1",
      });

      expect(section.textContent).not.toContain("Meeting notes");
      fireEvent.click(slot.getByRole("button", { name: /Unlinked mentions/ }));
      expect(section.textContent).toContain("Meeting notes");
      expect(section.textContent).toContain(
        "project planning shows up without a link",
      );

      fireEvent.click(slot.getByRole("button", { name: /Linked mentions/ }));
      expect(section.textContent).not.toContain("Team handbook");
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
