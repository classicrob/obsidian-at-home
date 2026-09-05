import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import type { StoredThinkingTrail } from "./thinking-trails.js";

function storedZip(fileName: string, content: Buffer): Buffer {
  const name = Buffer.from(fileName);
  const local = Buffer.alloc(30 + name.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  content.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

describe("wikilinks server", () => {
  it("makes the bundled usage skill and trail tool available to new sessions", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      agentSkillIds: ["obsidian-at-home"],
    });
    await plugin(bb);
    const configuration = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "thread-1", title: "Notes", parentThreadId: null, sourceThreadId: null },
      project: { id: "project-1", kind: "standard", name: "Notes", gitRemoteUrl: null },
      environment: { id: "env-1", name: null, path: "/notes", workspaceProvisionType: "unmanaged", branchName: null },
      host: { id: "host-1", name: "Local" },
      provider: { id: "codex", model: "test", capabilities: { supportsNativeUserQuestion: true } },
      origin: { kind: null, pluginId: null },
    });
    expect(configuration.skills).toEqual(["obsidian-at-home"]);
    expect(configuration.tools.map((tool) => tool.name)).toEqual(["query_thinking_trails"]);
    expect(configuration.instructions).toContain("Hover indicates curiosity");
    await harness.lifecycle.dispose();
  });

  it("stores branching thinking trails and joins click-through continuations", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "wikilinks" });
    await plugin(bb);
    const targetB = {
      kind: "workspace" as const,
      environmentId: "env-1",
      path: "notes/B.md",
    };
    const targetC = {
      kind: "workspace" as const,
      environmentId: "env-1",
      path: "notes/C.md",
    };

    const first = (await harness.behavior.callRpc("record_thinking_trail", {
      trail: {
        threadId: "thread-1",
        projectId: null,
        originKind: "chat",
        startedAtMs: 1_000,
        endedAtMs: 3_000,
        finishReason: "context-changed",
        steps: [
          {
            localId: "root-chat",
            parentLocalId: null,
            label: "Chat thread",
            target: null,
            relation: "root",
            previewMode: "note",
            enteredAtMs: 1_000,
            exitedAtMs: 3_000,
            dwellMs: 2_000,
            interactionCount: 0,
            clicked: false,
          },
          {
            localId: "b",
            parentLocalId: "root-chat",
            label: "B",
            target: targetB,
            relation: "link",
            previewMode: "note",
            enteredAtMs: 1_100,
            exitedAtMs: 3_000,
            dwellMs: 1_900,
            interactionCount: 1,
            clicked: true,
          },
        ],
      },
    })) as { id: number };
    const continued = (await harness.behavior.callRpc(
      "record_thinking_trail",
      {
        trail: {
          threadId: "thread-1",
          projectId: "project-1",
          originKind: "file",
          startedAtMs: 4_000,
          endedAtMs: 6_000,
          finishReason: "hover-chain-exited",
          steps: [
            {
              localId: "root-b",
              parentLocalId: null,
              label: "B",
              target: targetB,
              relation: "root",
              previewMode: "note",
              enteredAtMs: 4_000,
              exitedAtMs: 6_000,
              dwellMs: 2_000,
              interactionCount: 0,
              clicked: false,
            },
            {
              localId: "c",
              parentLocalId: "root-b",
              label: "C",
              target: targetC,
              relation: "backlink",
              previewMode: "backlinks",
              enteredAtMs: 4_200,
              exitedAtMs: 5_800,
              dwellMs: 1_600,
              interactionCount: 0,
              clicked: false,
            },
          ],
        },
      },
    )) as { id: number };

    expect(continued.id).toBe(first.id);
    const { trails } = (await harness.behavior.callRpc(
      "list_thinking_trails",
      { note: "C", limit: 10 },
    )) as { trails: StoredThinkingTrail[] };
    expect(trails).toHaveLength(1);
    expect(trails[0]).toMatchObject({
      id: first.id,
      projectId: "project-1",
      clickCount: 1,
      maxDepth: 2,
    });
    expect(trails[0]!.steps.map((step) => step.label)).toEqual([
      "Chat thread",
      "B",
      "C",
    ]);
    expect(trails[0]!.steps.map((step) => step.parentOrdinal)).toEqual([
      null,
      0,
      1,
    ]);
    await harness.lifecycle.dispose();
  });

  it("loads Markdown and resolves links to native workspace targets", async () => {
    const content =
      "Read [[Strategy]], [[Roadmap|the roadmap]], [[Canvas.tldraw|the canvas]], and [Example document.md](/workspace/Example%20document.md).";
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        environments: {
          get: async () => ({
            id: "env-1",
            path: "/workspace",
            hostId: "host-1",
          }) as never,
        },
        files: {
          read: async () => ({
            content,
            contentEncoding: "utf8",
            sha256: "abc",
            sizeBytes: content.length,
          }) as never,
          listPaths: async () => ({
            paths: [
              { kind: "file", path: "notes/Current.md" },
              { kind: "file", path: "notes/Strategy.md" },
              { kind: "file", path: "Roadmap.md" },
              { kind: "file", path: "notes/Canvas.tldraw" },
            ],
            truncated: false,
          }) as never,
        },
        hosts: {
          pathsExist: async ({ paths }) => ({
            existence: Object.fromEntries(
              paths.map((filePath) => [
                filePath,
                filePath === "/workspace/Example document.md",
              ]),
            ),
          }) as never,
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("open_markdown", {
      path: "notes/Current.md",
      source: {
        kind: "workspace",
        threadId: "thread-1",
        environmentId: "env-1",
        projectId: "project-1",
      },
    });

    expect(result).toEqual({
      content,
      sha256: "abc",
    });

    await expect(
      harness.behavior.callRpc("refresh_markdown", {
        path: "notes/Current.md",
        source: {
          kind: "workspace",
          threadId: "thread-1",
          environmentId: "env-1",
          projectId: "project-1",
        },
        knownSha256: "abc",
      }),
    ).resolves.toEqual({ changed: false, sha256: "abc" });

    await expect(
      harness.behavior.callRpc("refresh_markdown", {
        path: "notes/Current.md",
        source: {
          kind: "workspace",
          threadId: "thread-1",
          environmentId: "env-1",
          projectId: "project-1",
        },
        knownSha256: "older-sha",
      }),
    ).resolves.toEqual({ changed: true, content, sha256: "abc" });

    const resolvedLinks = await harness.behavior.callRpc(
      "resolve_markdown_links",
      {
        path: "notes/Current.md",
        source: {
          kind: "workspace",
          threadId: "thread-1",
          environmentId: "env-1",
          projectId: "project-1",
        },
        content,
      },
    );
    expect(resolvedLinks).toEqual({
      links: [
        {
          reference: "Strategy",
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "notes/Strategy.md",
          },
          exists: true,
        },
        {
          reference: "Roadmap",
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "Roadmap.md",
          },
          exists: true,
        },
        {
          reference: "Canvas.tldraw",
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "notes/Canvas.tldraw",
          },
          exists: true,
        },
        {
          reference: "/workspace/Example document.md",
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "Example document.md",
          },
          exists: true,
        },
      ],
    });
    await harness.lifecycle.dispose();
  });

  it("resolves chat wikilinks against the thread workspace", async () => {
    const content =
      "---\ntitle: Strategy\ntags: [work]\n---\n# Strategy\n\nA useful note. See [[notes/Details]].";
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thread-1",
            projectId: "project-1",
            environmentId: "env-1",
          }) as never,
        },
        environments: {
          get: async () => ({
            id: "env-1",
            path: "/workspace",
            hostId: "host-1",
          }) as never,
        },
        files: {
          read: async () => ({
            content,
            contentEncoding: "utf8",
            sha256: "preview",
            sizeBytes: content.length,
          }) as never,
          listPaths: async (args) => {
            if (args.query === "Strategy") {
              return {
                paths: [{ kind: "file", path: "notes/Strategy.md" }],
                truncated: false,
              } as never;
            }
            if (args.query === "notes/Details") {
              return {
                paths: [{ kind: "file", path: "notes/Details.md" }],
                truncated: false,
              } as never;
            }
            return {
              paths: [
                { kind: "file", path: "notes/Strategy.md" },
                { kind: "file", path: "archive/Details.md" },
              ],
              truncated: true,
            } as never;
          },
        },
        hosts: {
          pathsExist: async ({ paths }) => ({
            existence: Object.fromEntries(paths.map((filePath) => [filePath, true])),
          }) as never,
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("resolve_chat_wikilink", {
      threadId: "thread-1",
      reference: "Strategy",
    });

    expect(result).toEqual({
      target: {
        kind: "workspace",
        environmentId: "env-1",
        path: "notes/Strategy.md",
      },
      exists: true,
    });

    const localLink = await harness.behavior.callRpc(
      "resolve_chat_wikilink",
      {
        threadId: "thread-1",
        reference: "/workspace/notes/Strategy.md",
      },
    );
    expect(localLink).toEqual({
      target: {
        kind: "workspace",
        environmentId: "env-1",
        path: "notes/Strategy.md",
      },
      exists: true,
    });

    const preview = await harness.behavior.callRpc(
      "preview_chat_wikilink",
      {
        threadId: "thread-1",
        reference: "Strategy",
      },
    );
    expect(preview).toEqual({
      target: {
        kind: "workspace",
        environmentId: "env-1",
        path: "notes/Strategy.md",
      },
      exists: true,
      content: "# Strategy\n\nA useful note. See [[notes/Details]].",
      imageDataUrl: null,
      backlinks: null,
      truncated: false,
      links: [
        {
          reference: "notes/Details",
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "notes/Details.md",
          },
          exists: true,
        },
      ],
    });
    await harness.lifecycle.dispose();
  });

  it("saves edited Markdown with a compare-and-swap guard", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        environments: {
          get: async () => ({
            id: "env-save",
            path: "/save-workspace",
            hostId: "host-save",
          }) as never,
        },
        files: {
          write: async (args) => {
            writes.push(args as unknown as Record<string, unknown>);
            return args.expectedSha256 === "stale"
              ? { outcome: "conflict", currentSha256: "disk-sha" }
              : {
                  outcome: "written",
                  sha256: "next-sha",
                  sizeBytes: args.content.length,
                } as never;
          },
          listPaths: async () => ({
            paths: [],
            truncated: false,
          }) as never,
        },
      },
    });
    await plugin(bb);

    const written = await harness.behavior.callRpc("save_markdown", {
      path: "notes/Edit.md",
      source: {
        kind: "workspace",
        threadId: "thread-save",
        environmentId: "env-save",
        projectId: "project-save",
      },
      content: "# Edited\n",
      expectedSha256: "old-sha",
    });
    expect(written).toEqual({
      outcome: "written",
      sha256: "next-sha",
    });
    expect(writes[0]).toMatchObject({
      hostId: "host-save",
      path: "/save-workspace/notes/Edit.md",
      rootPath: "/save-workspace",
      content: "# Edited\n",
      contentEncoding: "utf8",
      createParents: false,
      expectedSha256: "old-sha",
    });

    const conflict = await harness.behavior.callRpc("save_markdown", {
      path: "notes/Edit.md",
      source: {
        kind: "workspace",
        threadId: "thread-save",
        environmentId: "env-save",
        projectId: "project-save",
      },
      content: "# Conflicting edit\n",
      expectedSha256: "stale",
    });
    expect(conflict).toEqual({
      outcome: "conflict",
      currentSha256: "disk-sha",
    });
    await harness.lifecycle.dispose();
  });

  it("extracts the embedded static preview from a tldraw archive", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    const archive = storedZip("preview.png", png);
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        environments: {
          get: async () => ({
            id: "env-canvas",
            path: "/canvas-workspace",
            hostId: "host-canvas",
          }) as never,
        },
        files: {
          read: async () => ({
            content: archive.toString("base64"),
            contentEncoding: "base64",
            sha256: "canvas-sha",
            sizeBytes: archive.length,
          }) as never,
        },
      },
    });
    await plugin(bb);

    const preview = await harness.behavior.callRpc("preview_file", {
      target: {
        kind: "workspace",
        environmentId: "env-canvas",
        path: "Canvas.tldraw",
      },
    });
    expect(preview).toEqual({
      content: null,
      imageDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      backlinks: null,
      truncated: false,
      links: [],
    });
    await harness.lifecycle.dispose();
  });

  it("returns contextual backlinks with heading breadcrumbs on command hover", async () => {
    const files: Record<string, string> = {
      "/backlink-workspace/Target.md": "# Target\n\nThe target note.",
      "/backlink-workspace/Source.md":
        "# Research\n\n## Useful angle\n\nThis paragraph explains why [[Target|the target]] matters alongside [[Related]].",
      "/backlink-workspace/Related.md": "# Related\n\nA related note.",
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thread-backlinks",
            projectId: "project-backlinks",
            environmentId: "env-backlinks",
          }) as never,
        },
        environments: {
          get: async () => ({
            id: "env-backlinks",
            path: "/backlink-workspace",
            hostId: "host-backlinks",
          }) as never,
        },
        files: {
          read: async ({ path }) => ({
            content: files[path]!,
            contentEncoding: "utf8",
            sha256: `sha-${path}`,
            sizeBytes: files[path]!.length,
          }) as never,
          listPaths: async () => ({
            paths: [
              { kind: "file", path: "Target.md" },
              { kind: "file", path: "Source.md" },
              { kind: "file", path: "Related.md" },
            ],
            truncated: false,
          }) as never,
        },
      },
    });
    await plugin(bb);

    const preview = await harness.behavior.callRpc(
      "preview_chat_wikilink",
      {
        threadId: "thread-backlinks",
        reference: "Target",
        backlinks: true,
      },
    );
    expect(preview).toMatchObject({
      exists: true,
      content: null,
      imageDataUrl: null,
      truncated: false,
      links: [],
      backlinks: [
        {
          sourceTitle: "Source",
          headings: ["Research", "Useful angle"],
          context:
            "This paragraph explains why [[Target|the target]] matters alongside [[Related]].",
          target: {
            kind: "workspace",
            environmentId: "env-backlinks",
            path: "Source.md",
          },
          links: [
            {
              reference: "Target",
              target: {
                kind: "workspace",
                environmentId: "env-backlinks",
                path: "Target.md",
              },
              exists: true,
            },
            {
              reference: "Related",
              target: {
                kind: "workspace",
                environmentId: "env-backlinks",
                path: "Related.md",
              },
              exists: true,
            },
          ],
        },
      ],
    });
    await harness.lifecycle.dispose();
  });

  it("fuzzily autocompletes unordered and mistyped note words from a cached index", async () => {
    let listCalls = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thread-fuzzy",
            projectId: "project-1",
            environmentId: "env-fuzzy",
          }) as never,
        },
        environments: {
          get: async () => ({
            id: "env-fuzzy",
            path: "/fuzzy-workspace",
            hostId: "host-fuzzy",
          }) as never,
        },
        files: {
          listPaths: async () => {
            listCalls += 1;
            return {
              paths: [
                {
                  kind: "file",
                  path: "examples/Planning team workshops for the next quarter.md",
                },
                { kind: "file", path: "examples/Workshop planning.md" },
                { kind: "file", path: "concepts/Meeting formats.md" },
              ],
              truncated: false,
            } as never;
          },
        },
      },
    });
    await plugin(bb);

    const unordered = (await harness.behavior.callRpc(
      "autocomplete_wikilinks",
      {
        threadId: "thread-fuzzy",
        query: "workshop team",
      },
    )) as Array<{ reference: string; label: string; directory: string }>;
    const mistyped = (await harness.behavior.callRpc(
      "autocomplete_wikilinks",
      {
        threadId: "thread-fuzzy",
        query: "tem workshp",
      },
    )) as Array<{ reference: string; label: string; directory: string }>;

    expect(unordered[0]).toEqual({
      reference:
        "examples/Planning team workshops for the next quarter",
      label:
        "Planning team workshops for the next quarter",
      directory: "examples/",
    });
    expect(mistyped[0]).toEqual(unordered[0]);
    expect(listCalls).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("imports only the public plugin SDK", async () => {
    const scan = await experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^react$/,
        /^react-dom$/,
        /^react-markdown$/,
        /^remark-gfm$/,
        /^sonner$/,
        /^@tiptap\//,
        /^tiptap-markdown$/,
        /^@testing-library\/react$/,
      ],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
