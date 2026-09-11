import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_DRAFT_MAX_AGE_MS,
  EDITOR_DRAFT_MAX_CHARS,
  clearEditorDraft,
  editorDraftKey,
  planDraftRestore,
  readEditorDraft,
  writeEditorDraft,
  type EditorDraft,
} from "./editor-draft.js";

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

const base = "# Note\n\nFirst paragraph.\n\nSecond paragraph.\n";
const draft: EditorDraft = {
  baseSha: "base-sha",
  base,
  markdown: "# Note\n\nFirst paragraph, edited.\n\nSecond paragraph.",
  editing: true,
  selection: { from: 12, to: 12 },
  at: 1_000_000,
};

describe("editor drafts in sessionStorage", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a draft under a key derived from the note's cache key", () => {
    writeEditorDraft("key-1", draft);
    expect(sessionStorage.getItem(editorDraftKey("key-1"))).not.toBeNull();
    expect(readEditorDraft("key-1")).toEqual(draft);
    clearEditorDraft("key-1");
    expect(readEditorDraft("key-1")).toBeNull();
  });

  it("does not park oversized notes and drops any earlier draft", () => {
    writeEditorDraft("key-2", draft);
    writeEditorDraft("key-2", {
      ...draft,
      markdown: "x".repeat(EDITOR_DRAFT_MAX_CHARS),
    });
    expect(readEditorDraft("key-2")).toBeNull();
  });

  it("ignores malformed drafts", () => {
    sessionStorage.setItem(editorDraftKey("key-3"), "{not json");
    expect(readEditorDraft("key-3")).toBeNull();
    sessionStorage.setItem(editorDraftKey("key-3"), JSON.stringify({ markdown: 1 }));
    expect(readEditorDraft("key-3")).toBeNull();
  });
});

describe("planDraftRestore", () => {
  const now = draft.at + 5_000;

  it("restores the draft as unsaved text when the file still matches its base", () => {
    expect(planDraftRestore(draft, { content: base, sha256: "base-sha" }, now)).toEqual({
      kind: "restore",
      markdown: draft.markdown,
    });
    expect(
      planDraftRestore({ ...draft, baseSha: null }, { content: base, sha256: "other" }, now),
    ).toEqual({ kind: "restore", markdown: draft.markdown });
  });

  it("merges the draft when the file moved on elsewhere", () => {
    const content = `${base}Appended by an agent.\n`;
    expect(planDraftRestore(draft, { content, sha256: "new-sha" }, now)).toEqual({
      kind: "merge",
      markdown: `${draft.markdown}\nAppended by an agent.\n`,
    });
  });

  it("reports a conflict when the file changed the same lines", () => {
    const content = base.replace("First paragraph.", "First paragraph, by an agent.");
    expect(planDraftRestore(draft, { content, sha256: "new-sha" }, now)).toEqual({
      kind: "conflict",
    });
  });

  it("discards stale drafts and drafts that add nothing", () => {
    expect(
      planDraftRestore(draft, { content: base, sha256: "base-sha" }, draft.at + EDITOR_DRAFT_MAX_AGE_MS + 1),
    ).toEqual({ kind: "none" });
    expect(
      planDraftRestore(draft, { content: draft.markdown, sha256: "saved" }, now),
    ).toEqual({ kind: "none" });
  });
});
