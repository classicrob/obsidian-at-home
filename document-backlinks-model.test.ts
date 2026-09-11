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

const host = { kind: "host" as const, hostId: "host_1", path: "/vault/Agent society.md" };

function backlink(overrides: Partial<VaultGraphBacklink>): VaultGraphBacklink {
  return {
    sourceKind: "note",
    sourceTitle: "Agent society",
    sourcePath: "Agent society.md",
    threadId: null,
    heading: null,
    context: "Needs [[Structured entropy|differences]].",
    line: 20,
    linkKind: "wikilink",
    target: host,
    ...overrides,
  };
}

describe("groupVaultGraphBacklinks", () => {
  it("groups occurrences by source and keeps threads without context", () => {
    const data = groupVaultGraphBacklinks({
      title: "Structured entropy",
      backlinks: [
        backlink({ heading: "Agent society", line: 20 }),
        backlink({
          heading: "Agent society > Why it matters",
          line: 31,
          context: "Also [[Structured entropy]] again.",
        }),
        backlink({
          sourceKind: "canvas",
          sourceTitle: "Ideas board",
          sourcePath: "Ideas board.tldraw",
          heading: "Ideas board > Sticky",
          context: "[[Structured entropy]] as a mutation source",
          line: null,
          target: { kind: "host", hostId: "host_1", path: "/vault/Ideas board.tldraw" },
        }),
        backlink({
          sourceKind: "thread",
          sourceTitle: "agent societies",
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
          sourceTitle: "Novelty search",
          sourcePath: "Novelty search.md",
          snippet: "structured entropy without a link",
          target: { kind: "host", hostId: "host_1", path: "/vault/Novelty search.md" },
        },
      ],
    });
    expect(data.provider).toBe("vault-graph");
    expect(data.linked.map((group) => [group.kind, group.title, group.occurrences.length])).toEqual([
      ["note", "Agent society", 2],
      ["canvas", "Ideas board", 1],
      ["thread", "agent societies", 0],
    ]);
    expect(data.linked[0]!.occurrences[1]).toEqual({
      headings: ["Agent society", "Why it matters"],
      context: "Also [[Structured entropy]] again.",
      line: 31,
    });
    expect(data.linked[2]).toMatchObject({ threadId: "thr_1", target: null });
    expect(data.unlinked).toHaveLength(1);
    expect(data.unlinked[0]!.occurrences[0]!.context).toBe("structured entropy without a link");
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
      "See [[Structured entropy|differences]], [[Other]] and [[folder/Structured entropy#Heading]].",
      "Structured entropy",
    );
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual([
      "[[Structured entropy|differences]]",
      "[[folder/Structured entropy#Heading]]",
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(
      "See [[Structured entropy|differences]], [[Other]] and [[folder/Structured entropy#Heading]].",
    );
  });

  it("is case-insensitive and tolerates .md suffixes", () => {
    expect(highlightContext("[[structured ENTROPY.md]]", "Structured entropy")[0]!.hit).toBe(true);
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
    expect(noteTitleFromPath("notes/Structured%20entropy.md")).toBe("Structured entropy");
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
