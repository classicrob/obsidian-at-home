import { describe, expect, it } from "vitest";
import {
  callVaultGraph,
  groupPreviewBacklinks,
  groupVaultGraphBacklinks,
  highlightContext,
  wikilinkDisplayLabel,
  noteTitleFromPath,
  previewTargetForOpener,
  splitHeadingBreadcrumb,
  VaultGraphUnavailableError,
  vaultGraphTargetForOpener,
  type VaultGraphBacklink,
} from "./document-backlinks-model.js";

const host = { kind: "host" as const, hostId: "host_1", path: "/vault/Team handbook.md" };

function backlink(overrides: Partial<VaultGraphBacklink>): VaultGraphBacklink {
  return {
    sourceKind: "note",
    sourceTitle: "Team handbook",
    sourcePath: "Team handbook.md",
    threadId: null,
    heading: null,
    context: "Needs [[Project planning|differences]].",
    line: 20,
    linkKind: "wikilink",
    target: host,
    ...overrides,
  };
}

describe("groupVaultGraphBacklinks", () => {
  it("groups occurrences by source and keeps threads without context", () => {
    const data = groupVaultGraphBacklinks({
      title: "Project planning",
      backlinks: [
        backlink({ heading: "Team handbook", line: 20 }),
        backlink({
          heading: "Team handbook > Why it matters",
          line: 31,
          context: "Also [[Project planning]] again.",
        }),
        backlink({
          sourceKind: "canvas",
          sourceTitle: "Ideas board",
          sourcePath: "Ideas board.tldraw",
          heading: "Ideas board > Sticky",
          context: "[[Project planning]] as a planning reference",
          line: null,
          target: { kind: "host", hostId: "host_1", path: "/vault/Ideas board.tldraw" },
        }),
        backlink({
          sourceKind: "thread",
          sourceTitle: "team discussion",
          sourcePath: null,
          threadId: "thr_1",
          heading: null,
          context: "",
          line: null,
          target: null,
        }),
      ],
      unlinked: [
        {
          sourceTitle: "Meeting notes",
          sourcePath: "Meeting notes.md",
          snippet: "project planning without a link",
          target: { kind: "host", hostId: "host_1", path: "/vault/Meeting notes.md" },
        },
      ],
    });
    expect(data.provider).toBe("vault-graph");
    expect(data.linked.map((group) => [group.kind, group.title, group.occurrences.length])).toEqual([
      ["note", "Team handbook", 2],
      ["canvas", "Ideas board", 1],
      ["thread", "team discussion", 0],
    ]);
    expect(data.linked[0]!.occurrences[1]).toEqual({
      headings: ["Team handbook", "Why it matters"],
      context: "Also [[Project planning]] again.",
      line: 31,
    });
    expect(data.linked[2]).toMatchObject({ threadId: "thr_1", target: null });
    expect(data.unlinked).toHaveLength(1);
    expect(data.unlinked[0]!.occurrences[0]!.context).toBe("project planning without a link");
  });

  it("drops duplicate occurrences of the same block", () => {
    const data = groupVaultGraphBacklinks({
      title: "T",
      backlinks: [backlink({}), backlink({})],
      unlinked: [],
    });
    expect(data.linked[0]!.occurrences).toHaveLength(1);
  });
});

describe("groupPreviewBacklinks", () => {
  it("maps wikilinks contextual backlinks into the same shape", () => {
    const data = groupPreviewBacklinks("Target", [
      {
        sourceTitle: "Source note",
        headings: ["Research", "Angle"],
        context: "Why [[Target]] matters.",
        target: { kind: "workspace", environmentId: "env", path: "notes/Source note.md" },
        links: [],
      },
      {
        sourceTitle: "Board",
        headings: [],
        context: "[[Target]] on the canvas",
        target: { kind: "workspace", environmentId: "env", path: "Board.tldraw" },
        links: [],
      },
    ]);
    expect(data.provider).toBe("wikilinks");
    expect(data.linked.map((group) => group.kind)).toEqual(["note", "canvas"]);
    expect(data.linked[0]!.occurrences[0]!.headings).toEqual(["Research", "Angle"]);
    expect(data.unlinked).toEqual([]);
  });
});

describe("highlightContext", () => {
  it("marks only the wikilinks that point at this note", () => {
    const parts = highlightContext(
      "See [[Project planning|differences]], [[Other]] and [[folder/Project planning#Heading]].",
      "Project planning",
    );
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual([
      "[[Project planning|differences]]",
      "[[folder/Project planning#Heading]]",
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(
      "See [[Project planning|differences]], [[Other]] and [[folder/Project planning#Heading]].",
    );
  });

  it("is case-insensitive and tolerates .md suffixes", () => {
    expect(highlightContext("[[project PLANNING.md]]", "Project planning")[0]!.hit).toBe(true);
    expect(highlightContext("plain text", "X")).toEqual([
      { text: "plain text", label: "plain text", link: false, hit: false },
    ]);
  });

  it("labels wikilinks the way Obsidian renders them", () => {
    const parts = highlightContext(
      "That is [[C- A market|a market of segments]] and [[folder/Other#Sub]] and [[Plain.md]].",
      "C- A market",
    );
    expect(parts.filter((part) => part.link).map((part) => part.label)).toEqual([
      "a market of segments",
      "Other › Sub",
      "Plain",
    ]);
    expect(parts[1]).toMatchObject({ hit: true, text: "[[C- A market|a market of segments]]" });
    expect(wikilinkDisplayLabel("A|B|C")).toBe("B|C");
    expect(wikilinkDisplayLabel("#Just heading")).toBe("Just heading");
  });
});

describe("target helpers", () => {
  it("builds vault-graph and preview targets from the opener source", () => {
    const workspace = { kind: "workspace" as const, threadId: "t", environmentId: "env", projectId: "p" };
    expect(vaultGraphTargetForOpener("a.md", workspace)).toEqual({ kind: "workspace", path: "a.md", environmentId: "env" });
    expect(previewTargetForOpener("a.md", workspace)).toEqual({ kind: "workspace", environmentId: "env", path: "a.md" });
    const hostSource = { kind: "host" as const, threadId: null, environmentId: null, projectId: null, experimental_hostId: "h" };
    expect(vaultGraphTargetForOpener("/x.md", hostSource)).toEqual({ kind: "host", path: "/x.md", hostId: "h" });
    expect(previewTargetForOpener("/x.md", hostSource)).toEqual({ kind: "host", hostId: "h", path: "/x.md" });
    expect(previewTargetForOpener("/x.md", { ...hostSource, experimental_hostId: undefined })).toBeNull();
  });

  it("derives the note title from the path", () => {
    expect(noteTitleFromPath("notes/Project%20planning.md")).toBe("Project planning");
    expect(splitHeadingBreadcrumb("A > B > C")).toEqual(["A", "B", "C"]);
    expect(splitHeadingBreadcrumb(null)).toEqual([]);
  });
});

describe("callVaultGraph", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("unwraps ok envelopes", async () => {
    const result = await callVaultGraph<{ inVault: boolean }>("resolve_target", {}, async () =>
      json(200, { ok: true, result: { inVault: true } }),
    );
    expect(result).toEqual({ inVault: true });
  });

  it("reports 404 and network failures as unavailable", async () => {
    await expect(
      callVaultGraph("note_panel", {}, async () => json(404, { ok: false, error: "unknown plugin" })),
    ).rejects.toBeInstanceOf(VaultGraphUnavailableError);
    await expect(
      callVaultGraph("note_panel", {}, async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toBeInstanceOf(VaultGraphUnavailableError);
  });

  it("surfaces plugin errors with their message", async () => {
    await expect(
      callVaultGraph("note_panel", {}, async () => json(500, { ok: false, error: "Not indexed: a.md" })),
    ).rejects.toThrow("Not indexed: a.md");
  });
});
