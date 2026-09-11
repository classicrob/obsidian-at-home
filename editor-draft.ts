import { mergeThreeWay } from "./three-way-merge.js";

/**
 * Unsaved editor text parked in `sessionStorage` so a plugin bundle reload
 * (which remounts every open note) hands the same text, editing mode and
 * caret back to the next mount instead of dropping them.
 */
export interface EditorDraft {
  /** Sha of the file the draft was typed on top of, when known. */
  baseSha: string | null;
  /** The file content the draft was typed on top of. */
  base: string;
  /** The editor's unsaved markdown. */
  markdown: string;
  editing: true;
  selection: { from: number; to: number } | null;
  /** `Date.now()` when the draft was written. */
  at: number;
}

/** Drafts older than this are ignored; the file on disk wins. */
export const EDITOR_DRAFT_MAX_AGE_MS = 2 * 60_000;
/** Notes whose draft plus base would exceed this are not parked at all. */
export const EDITOR_DRAFT_MAX_CHARS = 400_000;

const DRAFT_KEY_PREFIX = "wikilinks:editor-draft:";

export function editorDraftKey(cacheKey: string): string {
  return `${DRAFT_KEY_PREFIX}${cacheKey}`;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readEditorDraft(cacheKey: string): EditorDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(editorDraftKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EditorDraft>;
    if (
      typeof parsed.markdown !== "string" ||
      typeof parsed.base !== "string" ||
      typeof parsed.at !== "number"
    ) {
      return null;
    }
    const selection =
      parsed.selection &&
      typeof parsed.selection.from === "number" &&
      typeof parsed.selection.to === "number"
        ? { from: parsed.selection.from, to: parsed.selection.to }
        : null;
    return {
      baseSha: typeof parsed.baseSha === "string" ? parsed.baseSha : null,
      base: parsed.base,
      markdown: parsed.markdown,
      editing: true,
      selection,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

/** Parks the draft, or drops any existing one when the note is too large. */
export function writeEditorDraft(cacheKey: string, draft: EditorDraft): void {
  const store = storage();
  if (!store) return;
  const key = editorDraftKey(cacheKey);
  try {
    if (draft.markdown.length + draft.base.length > EDITOR_DRAFT_MAX_CHARS) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota or private-mode failures just mean no draft survives a reload.
  }
}

export function clearEditorDraft(cacheKey: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(editorDraftKey(cacheKey));
  } catch {
    // Nothing to clear.
  }
}

export type DraftRestorePlan =
  /** The draft is stale or adds nothing; discard it. */
  | { kind: "none" }
  /** The file still matches the draft's base: the draft is the unsaved text. */
  | { kind: "restore"; markdown: string }
  /** The file moved on but the draft merged cleanly on top of it. */
  | { kind: "merge"; markdown: string }
  /** The file moved on and the draft collides with it. */
  | { kind: "conflict" };

/** What to do with a draft found for a note whose file now reads `file`. */
export function planDraftRestore(
  draft: EditorDraft,
  file: { content: string; sha256: string },
  now = Date.now(),
): DraftRestorePlan {
  if (now - draft.at > EDITOR_DRAFT_MAX_AGE_MS || draft.at > now + 60_000) {
    return { kind: "none" };
  }
  if (draft.markdown === file.content) return { kind: "none" };
  if (
    (draft.baseSha !== null && draft.baseSha === file.sha256) ||
    draft.base === file.content
  ) {
    return { kind: "restore", markdown: draft.markdown };
  }
  const merge = mergeThreeWay(draft.base, draft.markdown, file.content);
  if (!merge.ok) return { kind: "conflict" };
  if (merge.merged === file.content) return { kind: "none" };
  return { kind: "merge", markdown: merge.merged };
}
