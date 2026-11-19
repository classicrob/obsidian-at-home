import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const hostId = "notes-host";
const source = {
  kind: "host",
  threadId: null,
  environmentId: null,
  projectId: null,
  experimental_hostId: hostId,
};

describe("host-file workspace context", () => {
  it("resolves sibling notes on open, recursive preview, and backlink lookup", async () => {
    const root = "/host-context-vault";
    const files: Record<string, string> = {
      [`${root}/meetings/2026-08/Planning.md`]: "# Planning\n\n[[actors/Участник]]",
      [`${root}/actors/Участник.md`]: "# Participant\n\n[[projects/Launch]]",
      [`${root}/projects/Launch.md`]: "# Launch\n\nThe project.",
    };
    const projects = vi.fn(async () => [{ sources: [{ hostId, path: root }] }] as never);
    const environments = vi.fn(async () => [] as never);
    const write = vi.fn();
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        projects: { list: projects },
        environments: { list: environments },
        hosts: {
          pathsExist: async ({ paths }) => ({
            existence: Object.fromEntries(paths.map((path) => [path, path in files])),
          }) as never,
        },
        files: {
          read: async ({ path }) => {
            const content = files[path];
            if (content === undefined) throw new Error("Not found");
            return { content, contentEncoding: "utf8", sha256: path, sizeBytes: content.length } as never;
          },
          listPaths: async ({ path }) => ({
            paths: Object.keys(files)
              .filter((file) => file.startsWith(`${path}/`))
              .map((file) => ({ kind: "file", path: file.slice(path!.length + 1) })),
            truncated: false,
          }) as never,
          write,
        },
      },
    });
    try {
      await plugin(bb);
      const actor = { kind: "host", hostId, path: `${root}/actors/Участник.md` };
      const project = { kind: "host", hostId, path: `${root}/projects/Launch.md` };
      const note = { kind: "host", hostId, path: `${root}/meetings/2026-08/Planning.md` };

      await expect(harness.behavior.callRpc("resolve_markdown_links", {
        path: note.path,
        source,
        content: files[note.path],
      })).resolves.toEqual({ links: [{ reference: "actors/Участник", target: actor, exists: true }] });

      await expect(harness.behavior.callRpc("preview_file", { target: note }))
        .resolves.toMatchObject({ links: [{ reference: "actors/Участник", target: actor, exists: true }] });
      await expect(harness.behavior.callRpc("preview_file", { target: actor }))
        .resolves.toMatchObject({ links: [{ reference: "projects/Launch", target: project, exists: true }] });
      await expect(harness.behavior.callRpc("preview_file", { target: actor, backlinks: true }))
        .resolves.toMatchObject({ backlinks: [{ sourceTitle: "Planning", target: note }] });

      await expect(harness.behavior.callRpc("resolve_markdown_links", {
        path: note.path,
        source,
        content: "[Participant](../../actors/Участник.md)",
      })).resolves.toMatchObject({ links: [{ target: actor, exists: true }] });
      expect(projects).toHaveBeenCalledTimes(1);
      expect(environments).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each([
    {
      name: "deepest registered project source",
      file: "/vault/nested/meetings/Note.md",
      sources: ["/vault", "/vault/nested"],
      environments: [],
      expected: "/vault/nested",
    },
    {
      name: "worktree environment",
      file: "/worktrees/topic/meetings/Note.md",
      sources: ["/worktrees"],
      environments: [{ hostId, path: "/worktrees/topic" }],
      expected: "/worktrees/topic",
    },
    {
      name: "other-host environment is ignored",
      file: "/vault/meetings/Note.md",
      sources: ["/vault"],
      environments: [{ hostId: "another-host", path: "/vault/meetings" }],
      expected: "/vault",
    },
    {
      name: "sibling path prefix is not containment",
      file: "/vault-copy/meetings/Note.md",
      sources: ["/vault"],
      environments: [],
      expected: "/vault-copy/meetings",
    },
    {
      name: "dot-prefixed child is inside the root",
      file: "/vault/..notes/Note.md",
      sources: ["/vault"],
      environments: [],
      expected: "/vault",
    },
    {
      name: "Windows project source",
      file: "C:\\Vault\\meetings\\Note.md",
      sources: ["C:\\Vault"],
      environments: [],
      expected: "C:\\Vault",
    },
    {
      name: "UNC project source",
      file: "\\\\server\\share\\Vault\\meetings\\Note.md",
      sources: ["\\\\server\\share\\Vault"],
      environments: [],
      expected: "\\\\server\\share\\Vault",
    },
  ])("uses the $name", async ({ file, sources, environments, expected }) => {
    const read = vi.fn(async () => ({ content: "note", contentEncoding: "utf8", sha256: "test", sizeBytes: 4 }) as never);
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        projects: { list: async () => [{ sources: [
          { hostId: "another-host", path: "/vault/meetings" },
          ...sources.map((path) => ({ hostId, path })),
        ] }] as never },
        environments: { list: async () => environments as never },
        files: { read },
      },
    });
    try {
      await plugin(bb);
      await harness.behavior.callRpc("open_markdown", { path: file, source });
      expect(read).toHaveBeenCalledWith({ hostId, path: file, rootPath: expected });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each(["rejects", "throws"])("keeps standalone host files readable when discovery %s", async (failure) => {
    const read = vi.fn(async () => ({ content: "note", contentEncoding: "utf8", sha256: "test", sizeBytes: 4 }) as never);
    const unavailable = async (): Promise<never> => { throw new Error("Unavailable"); };
    const unavailableSynchronously = (): never => { throw new Error("Unavailable"); };
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        projects: { list: unavailable },
        environments: { list: failure === "throws" ? unavailableSynchronously : unavailable },
        files: { read },
      },
    });
    try {
      await plugin(bb);
      await harness.behavior.callRpc("open_markdown", { path: "/standalone/Note.md", source });
      expect(read).toHaveBeenCalledWith({ hostId, path: "/standalone/Note.md", rootPath: "/standalone" });
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("retries discovery after a transient project failure without waiting for the cache TTL", async () => {
    const root = "/recovering-vault";
    const projects = vi.fn()
      .mockRejectedValueOnce(new Error("Temporarily unavailable"))
      .mockResolvedValue([{ sources: [{ hostId, path: root }] }]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        projects: { list: projects as never },
        environments: { list: async () => [] },
        files: {
          listPaths: async ({ path }) => ({
            paths: path === root ? [{ kind: "file", path: "actors/Participant.md" }] : [],
            truncated: false,
          }) as never,
        },
      },
    });
    try {
      await plugin(bb);
      const input = { path: `${root}/meetings/Note.md`, source, content: "[[actors/Participant]]" };
      await expect(harness.behavior.callRpc("resolve_markdown_links", input))
        .resolves.toMatchObject({ links: [{ exists: false }] });
      await expect(harness.behavior.callRpc("resolve_markdown_links", input))
        .resolves.toMatchObject({ links: [{ exists: true, target: { path: `${root}/actors/Participant.md` } }] });
      expect(projects).toHaveBeenCalledTimes(2);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each(["rejects", "throws"])("uses project roots and retries when the environment catalog %s", async (failure) => {
    const root = "/partially-discovered-vault";
    const environments = vi.fn()
      .mockImplementationOnce(() => {
        if (failure === "throws") throw new Error("Temporarily unavailable");
        return Promise.reject(new Error("Temporarily unavailable"));
      })
      .mockResolvedValue([{ hostId, path: `${root}/nested` }]);
    const read = vi.fn(async () => ({ content: "note", contentEncoding: "utf8", sha256: "test", sizeBytes: 4 }) as never);
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: {
        projects: { list: async () => [{ sources: [{ hostId, path: root }] }] as never },
        environments: { list: environments as never },
        files: { read },
      },
    });
    try {
      await plugin(bb);
      const input = { path: `${root}/nested/Note.md`, source };
      await harness.behavior.callRpc("open_markdown", input);
      expect(read).toHaveBeenLastCalledWith({ hostId, path: input.path, rootPath: root });
      await harness.behavior.callRpc("open_markdown", input);
      expect(read).toHaveBeenLastCalledWith({ hostId, path: input.path, rootPath: `${root}/nested` });
      expect(environments).toHaveBeenCalledTimes(2);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("rejects relative host paths before looking up workspaces or reading files", async () => {
    const projects = vi.fn();
    const read = vi.fn();
    const { bb, harness } = createFakePluginHost({
      pluginId: "wikilinks",
      sdk: { projects: { list: projects }, files: { read } },
    });
    try {
      await plugin(bb);
      await expect(harness.behavior.callRpc("open_markdown", { path: "../Note.md", source }))
        .rejects.toThrow("Host file paths must be absolute");
      expect(projects).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
