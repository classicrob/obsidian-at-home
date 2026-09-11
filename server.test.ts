import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it("reuses indexed links and shares missing-link searches across concurrent previews", async () => {
    const queries: Array<string | undefined> = [];
    const content = "[[Known]] [[notes/Details]] [[Missing#one]] [[Missing#two]]";
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        environments: { get: async () => ({ path: "/perf-vault", hostId: "perf-host" }) as never },
        files: {
          read: async () => ({ content, contentEncoding: "utf8", sha256: "test", sizeBytes: content.length }) as never,
          listPaths: async ({ query }) => {
            queries.push(query);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              paths: (query === "notes/Details" ? ["notes/Details.md"] : query ? [] : ["Known.md", "archive/Details.md"])
                .map((path) => ({ kind: "file", path })),
              truncated: !query,
            } as never;
          },
        },
      },
    });
    await plugin(bb);
    const input = { target: { kind: "workspace", environmentId: "perf-env", path: "Note.md" } };
    const results = await Promise.all([
      harness.behavior.callRpc("preview_file", input),
      harness.behavior.callRpc("preview_file", input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ content, links: [
      { reference: "Known", exists: true, target: { path: "Known.md" } },
      { reference: "notes/Details", exists: true, target: { path: "notes/Details.md" } },
      { reference: "Missing#one", exists: false },
      { reference: "Missing#two", exists: false },
    ] });
    expect(queries).toEqual([undefined, "notes/Details", "Missing"]);
    await harness.behavior.callRpc("preview_file", input);
    expect(queries).toHaveLength(3);
    await harness.lifecycle.dispose();
  });

  it("indexes a locally readable vault off disk instead of searching the host per link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wikilinks-vault-"));
    await mkdir(path.join(root, "notes"));
    await mkdir(path.join(root, ".obsidian"));
    const content = "[[Known]] [[Details]] [[Missing]]";
    await writeFile(path.join(root, "Note.md"), content, "utf8");
    await writeFile(path.join(root, "Known.md"), "known", "utf8");
    await writeFile(path.join(root, "notes", "Details.md"), "details", "utf8");
    await writeFile(path.join(root, ".obsidian", "workspace.md"), "hidden", "utf8");
    const listPaths = vi.fn();
    const read = vi.fn();
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        environments: {
          get: async () => ({ path: root, hostId: "local-host" }) as never,
        },
        hosts: {
          directory: async () => ({
            directory: root,
            parent: null,
            entries: (await readdir(root, { withFileTypes: true })).map(
              (entry) => ({
                kind: entry.isDirectory() ? "directory" : "file",
                name: entry.name,
                path: path.join(root, entry.name),
              }),
            ),
          }) as never,
          pathsExist: async () => ({ existence: {} }) as never,
        },
        files: { listPaths, read },
      },
    });
    await plugin(bb);
    const preview = await harness.behavior.callRpc("preview_file", {
      target: { kind: "workspace", environmentId: "local-env", path: "Note.md" },
    });

    expect(preview).toMatchObject({
      content,
      links: [
        { reference: "Known", exists: true, target: { path: "Known.md" } },
        { reference: "Details", exists: true, target: { path: "notes/Details.md" } },
        { reference: "Missing", exists: false },
      ],
    });
    // The whole point: no host listing, no per-reference search, no host read.
    expect(listPaths).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await harness.lifecycle.dispose();
  });

  it("refreshes a locally readable note from disk and answers later polls from a stat", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wikilinks-refresh-"));
    const notePath = path.join(root, "Live.md");
    await writeFile(notePath, "one\n", "utf8");
    const hexSha = (value: string) => createHash("sha256").update(value).digest("hex");
    const read = vi.fn(async () => {
      const content = await readFile(notePath, "utf8");
      return { content, contentEncoding: "utf8", sha256: hexSha(content), sizeBytes: Buffer.byteLength(content) } as never;
    });
    const write = vi.fn(async ({ content }: { content: string }) => {
      await writeFile(notePath, content, "utf8");
      return { outcome: "written", sha256: hexSha(content), sizeBytes: Buffer.byteLength(content) } as never;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        environments: { get: async () => ({ path: root, hostId: "local-host" }) as never },
        hosts: {
          directory: async () => ({
            directory: root,
            parent: null,
            entries: (await readdir(root, { withFileTypes: true })).map((entry) => ({
              kind: entry.isDirectory() ? "directory" : "file",
              name: entry.name,
              path: path.join(root, entry.name),
            })),
          }) as never,
        },
        files: { read, write },
      },
    });
    try {
      await plugin(bb);
      const source = { kind: "workspace" as const, threadId: null, environmentId: "local-env", projectId: null };
      const opened = await harness.behavior.callRpc("open_markdown", { path: "Live.md", source });
      expect(opened).toEqual({ content: "one\n", sha256: hexSha("one\n") });
      expect(read).toHaveBeenCalledTimes(1);

      // Unchanged: answered from the memo the open filled, no host read.
      await expect(harness.behavior.callRpc("refresh_markdown", { path: "Live.md", source, knownSha256: hexSha("one\n") }))
        .resolves.toEqual({ changed: false, sha256: hexSha("one\n") });

      // Changed on disk: hashed locally with the host's hex format.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(notePath, "one\ntwo\n", "utf8");
      await expect(harness.behavior.callRpc("refresh_markdown", { path: "Live.md", source, knownSha256: hexSha("one\n") }))
        .resolves.toEqual({ changed: true, content: "one\ntwo\n", sha256: hexSha("one\ntwo\n") });
      await expect(harness.behavior.callRpc("refresh_markdown", { path: "Live.md", source, knownSha256: hexSha("one\ntwo\n") }))
        .resolves.toEqual({ changed: false, sha256: hexSha("one\ntwo\n") });

      // A second editor can still hold the old sha after another poll updated the memo.
      await expect(harness.behavior.callRpc("refresh_markdown", { path: "Live.md", source, knownSha256: hexSha("one\n") }))
        .resolves.toEqual({ changed: true, content: "one\ntwo\n", sha256: hexSha("one\ntwo\n") });

      // A save re-primes the memo with the written sha.
      await expect(harness.behavior.callRpc("save_markdown", { path: "Live.md", source, content: "saved\n", expectedSha256: hexSha("one\ntwo\n") }))
        .resolves.toEqual({ outcome: "written", sha256: hexSha("saved\n") });
      await expect(harness.behavior.callRpc("refresh_markdown", { path: "Live.md", source, knownSha256: hexSha("saved\n") }))
        .resolves.toEqual({ changed: false, sha256: hexSha("saved\n") });
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await harness.lifecycle.dispose();
    }
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

  it("aborts a stalled refresh read within five seconds and allows the next read", async () => {
    vi.useFakeTimers();
    let readSignal: AbortSignal | undefined;
    const { bb, harness } = createFakePluginHost({ pluginId: "wikilinks", sdk: {
      files: { read: async ({ signal }) => {
        readSignal = signal;
        return await new Promise<never>(() => {});
      } },
    } });
    try {
      await plugin(bb);
      const input = {
        path: "/notes/Test.md",
        source: { kind: "host", threadId: null, environmentId: null, projectId: null, experimental_hostId: "host-1" },
        knownSha256: "old",
      };
      const pending = harness.behavior.callRpc("refresh_markdown", input);
      const rejected = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(5_001);
      await rejected;
      expect(readSignal?.aborted).toBe(true);
      harness.inspection.sdk.stub("files.read", async () => ({ content: "New segment", contentEncoding: "utf8", sha256: "new", sizeBytes: 11 }) as never);
      await expect(harness.behavior.callRpc("refresh_markdown", input)).resolves.toEqual({ changed: true, content: "New segment", sha256: "new" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds context lookup and does not start a read after its deadline", async () => {
    vi.useFakeTimers();
    let finish!: (value: never) => void;
    const { bb, harness } = createFakePluginHost({ pluginId: "wikilinks", sdk: {
      environments: { get: () => new Promise<never>((resolve) => { finish = resolve; }) },
    } });
    try {
      await plugin(bb);
      const pending = harness.behavior.callRpc("refresh_markdown", {
        path: "Test.md",
        source: { kind: "workspace", threadId: null, environmentId: "env-1", projectId: null },
        knownSha256: "old",
      });
      const rejected = expect(pending).rejects.toThrow("timed out during resolve context");
      await vi.advanceTimersByTimeAsync(5_001);
      await rejected;
      finish({ path: "/notes", hostId: "host-1" } as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.inspection.sdk.callsTo("files.read")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("loads Markdown and resolves links to native workspace targets", async () => {
    const content =
      "Read [[Strategy]], [[Roadmap|the roadmap]], [[Canvas.tldraw|the canvas]], and [Continual learning.md](/workspace/Continual%20learning.md).";
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
                filePath === "/workspace/Continual learning.md",
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
          reference: "/workspace/Continual learning.md",
          target: {
            kind: "workspace",
            environmentId: "env-1",
            path: "Continual learning.md",
          },
          exists: true,
        },
      ],
    });
    await harness.lifecycle.dispose();
  });

  it.each([0, 10_000])("resolves chat wikilinks and previews the complete note with %i extra characters", async (length) => {
    const body = `# Strategy\n\n${"x".repeat(length)}A useful note. See [[notes/Details]].`;
    const content = `---\ntitle: Strategy\ntags: [work]\n---\n${body}`;
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
      content: body,
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
                  path: "websim/I- Prompt arenas into existence to create a market for model capabilities.md",
                },
                { kind: "file", path: "websim/Prompt engineering.md" },
                { kind: "file", path: "concepts/Capability markets.md" },
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
        query: "arena prompt",
      },
    )) as Array<{ reference: string; label: string; directory: string }>;
    const mistyped = (await harness.behavior.callRpc(
      "autocomplete_wikilinks",
      {
        threadId: "thread-fuzzy",
        query: "prmpt arna",
      },
    )) as Array<{ reference: string; label: string; directory: string }>;

    expect(unordered[0]).toEqual({
      reference:
        "websim/I- Prompt arenas into existence to create a market for model capabilities",
      label:
        "I- Prompt arenas into existence to create a market for model capabilities",
      directory: "websim/",
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
        /^diff$/,
        /^@testing-library\/react$/,
      ],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});

describe("opening missing notes", () => {
  const input = { path: "nested/New note.md", source: { kind: "workspace", environmentId: "env-1", threadId: "thread-1", projectId: "project-1" } };
  async function setup({ exists = false, race = false, failProbe = false } = {}) {
    let content: string | null = exists ? "Existing text" : null;
    const writes: unknown[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId: "wikilinks", sdk: {
      environments: { get: async () => ({ path: "/workspace", hostId: "host-1" }) as never },
      hosts: { pathsExist: async () => {
        if (failProbe) throw new Error("Host offline");
        return { existence: { "/workspace/nested/New note.md": exists } };
      } },
      files: {
        read: async () => {
          if (content === null || exists) throw new Error(exists ? "Permission denied" : "File missing");
          return { content, contentEncoding: "utf8", sha256: "sha", sizeBytes: content.length } as never;
        },
        write: async args => {
          writes.push(args);
          content = race ? "Created by another client" : "";
          return race ? { outcome: "conflict", currentSha256: "sha" } as never : { outcome: "written", sha256: "sha" } as never;
        },
      },
    } });
    await plugin(bb);
    return { harness, writes };
  }
  it("creates only on an explicit open, with an atomic create-only write", async () => {
    const { harness, writes } = await setup();
    await expect(harness.behavior.callRpc("open_markdown", input)).rejects.toThrow();
    expect(writes).toEqual([]);
    await expect(harness.behavior.callRpc("open_markdown", { ...input, createIfMissing: true })).resolves.toEqual({ content: "", sha256: "sha", created: true });
    expect(writes).toEqual([{ hostId: "host-1", path: "/workspace/nested/New note.md", rootPath: "/workspace", content: "", contentEncoding: "utf8", createParents: true, expectedSha256: null }]);
    await harness.lifecycle.dispose();
  });
  it("preserves a note created by another client during the open", async () => {
    const { harness } = await setup({ race: true });
    await expect(harness.behavior.callRpc("open_markdown", { ...input, createIfMissing: true })).resolves.toEqual({ content: "Created by another client", sha256: "sha" });
    await harness.lifecycle.dispose();
  });
  it.each([{ exists: true }, { failProbe: true }])("does not turn read or connection errors into writes: %j", async options => {
    const { harness, writes } = await setup(options);
    await expect(harness.behavior.callRpc("open_markdown", { ...input, createIfMissing: true })).rejects.toThrow();
    expect(writes).toEqual([]);
    await harness.lifecycle.dispose();
  });
});
