// Pure helpers for the "backlinks in document" section: vault-graph RPC
// transport, grouping of backlinks by source, and context highlighting.
// Kept free of React so the grouping and highlight logic is unit-testable.
import type {
  ExperimentalLiveFileTarget,
  PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import type { HoverPreviewBacklink } from "./hover-preview.js";

export const VAULT_GRAPH_PLUGIN_ID = "vault-graph";
export const DOCUMENT_BACKLINKS_COLLAPSED_KEY =
  "wikilinks:document-backlinks:collapsed";
export const DOCUMENT_UNLINKED_EXPANDED_KEY =
  "wikilinks:document-backlinks:unlinked-expanded";

export type BacklinkSourceKind = "note" | "canvas" | "thread";

export interface VaultGraphResolvedTarget {
  inVault: boolean;
  path?: string;
  title?: string;
  entityId?: number;
  reason?: string;
}

export interface VaultGraphBacklink {
  sourceKind: BacklinkSourceKind;
  sourceTitle: string;
  sourcePath: string | null;
  threadId: string | null;
  heading: string | null;
  context: string | null;
  line: number | null;
  linkKind: string | null;
  target: ExperimentalLiveFileTarget | null;
}

export interface VaultGraphUnlinkedMention {
  sourceTitle: string;
  sourcePath: string;
  snippet: string;
  target: ExperimentalLiveFileTarget;
}

export interface VaultGraphNotePanel {
  title: string;
  path: string;
  kind: "note" | "canvas";
  entityId: number;
  backlinks: VaultGraphBacklink[];
  unlinked: VaultGraphUnlinkedMention[];
}

export interface DocumentBacklinkOccurrence {
  headings: string[];
  context: string;
  line: number | null;
}

export interface DocumentBacklinkGroup {
  key: string;
  kind: BacklinkSourceKind;
  title: string;
  target: ExperimentalLiveFileTarget | null;
  threadId: string | null;
  occurrences: DocumentBacklinkOccurrence[];
}

export interface DocumentBacklinksData {
  /** Title used to decide which `[[wikilink]]` in a context line is "this note". */
  title: string;
  linked: DocumentBacklinkGroup[];
  unlinked: DocumentBacklinkGroup[];
  /** Which index answered: the vault graph or the wikilinks preview fallback. */
  provider: "vault-graph" | "wikilinks";
}

/** Thrown when the vault-graph plugin cannot be reached (missing, disabled, or offline). */
export class VaultGraphUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultGraphUnavailableError";
  }
}

export async function callVaultGraph<T>(
  method: string,
  input: unknown,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(
      `/api/v1/plugins/${VAULT_GRAPH_PLUGIN_ID}/rpc/${method}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? null),
      },
    );
  } catch (cause) {
    throw new VaultGraphUnavailableError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 404 || response.status === 503) {
    throw new VaultGraphUnavailableError(
      `vault-graph is not available (${response.status})`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`vault-graph returned a non-JSON response (${response.status})`);
  }
  const envelope = payload as
    | { ok: true; result: T }
    | { ok: false; error?: unknown }
    | null;
  if (!response.ok || !envelope || envelope.ok !== true) {
    const error = envelope && envelope.ok === false ? envelope.error : undefined;
    const message =
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : `vault-graph request failed (${response.status})`;
    throw new Error(message);
  }
  return envelope.result;
}

/** The `resolve_target` input vault-graph expects for an opener's file. */
export function vaultGraphTargetForOpener(
  path: string,
  source: PluginFileOpenerSource,
): {
  kind: "workspace" | "host" | "thread-storage" | "project";
  path: string;
  environmentId?: string;
  threadId?: string;
  projectId?: string | null;
  hostId?: string | null;
} {
  if (source.kind === "workspace" && source.environmentId) {
    return { kind: "workspace", path, environmentId: source.environmentId };
  }
  if (source.kind === "workspace") {
    return {
      kind: "project",
      path,
      projectId: source.projectId,
      hostId: source.experimental_hostId ?? null,
    };
  }
  if (source.kind === "thread-storage" && source.threadId) {
    return { kind: "thread-storage", path, threadId: source.threadId };
  }
  return { kind: "host", path, hostId: source.experimental_hostId ?? null };
}

/** The live file target wikilinks' own `preview_file` accepts for the open note. */
export function previewTargetForOpener(
  path: string,
  source: PluginFileOpenerSource,
): ExperimentalLiveFileTarget | null {
  if (source.kind === "workspace" && source.environmentId) {
    return { kind: "workspace", environmentId: source.environmentId, path };
  }
  if (source.kind === "host" && source.experimental_hostId) {
    return { kind: "host", hostId: source.experimental_hostId, path };
  }
  if (source.kind === "thread-storage" && source.threadId) {
    return { kind: "thread-storage", threadId: source.threadId, path };
  }
  return null;
}

export function noteTitleFromPath(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").at(-1) ?? filePath;
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // keep the raw name
  }
  return decoded.replace(/\.(?:md|markdown|tldraw)$/i, "");
}

/** vault-graph joins heading trails with " > "; split them back into crumbs. */
export function splitHeadingBreadcrumb(heading: string | null | undefined): string[] {
  if (!heading) return [];
  return heading
    .split(/\s+>\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function groupKey(kind: BacklinkSourceKind, identity: string): string {
  return `${kind}:${identity}`;
}

export function groupVaultGraphBacklinks(
  panel: Pick<VaultGraphNotePanel, "title" | "backlinks" | "unlinked">,
): DocumentBacklinksData {
  const groups = new Map<string, DocumentBacklinkGroup>();
  for (const row of panel.backlinks) {
    const key = groupKey(
      row.sourceKind,
      row.sourcePath ?? row.threadId ?? row.sourceTitle,
    );
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        kind: row.sourceKind,
        title: row.sourceTitle,
        target: row.target,
        threadId: row.threadId,
        occurrences: [],
      };
      groups.set(key, group);
    }
    const context = row.context?.trim() ?? "";
    if (context === "") continue;
    const headings = splitHeadingBreadcrumb(row.heading);
    const duplicate = group.occurrences.some(
      (existing) =>
        existing.context === context &&
        existing.headings.join("\0") === headings.join("\0"),
    );
    if (duplicate) continue;
    group.occurrences.push({ headings, context, line: row.line });
  }
  const unlinked: DocumentBacklinkGroup[] = panel.unlinked.map((row) => ({
    key: groupKey("note", `unlinked:${row.sourcePath}`),
    kind: "note",
    title: row.sourceTitle,
    target: row.target,
    threadId: null,
    occurrences: row.snippet.trim()
      ? [{ headings: [], context: row.snippet.trim(), line: null }]
      : [],
  }));
  return {
    title: panel.title,
    linked: [...groups.values()],
    unlinked,
    provider: "vault-graph",
  };
}

/** Same shape from wikilinks' own `preview_file` contextual backlinks. */
export function groupPreviewBacklinks(
  title: string,
  backlinks: readonly HoverPreviewBacklink[],
): DocumentBacklinksData {
  const groups = new Map<string, DocumentBacklinkGroup>();
  for (const row of backlinks) {
    const kind: BacklinkSourceKind = /\.tldraw$/i.test(row.target.path)
      ? "canvas"
      : "note";
    const key = groupKey(kind, row.target.path);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        kind,
        title: row.sourceTitle,
        target: row.target,
        threadId: null,
        occurrences: [],
      };
      groups.set(key, group);
    }
    const context = row.context.trim();
    if (context === "") continue;
    group.occurrences.push({ headings: row.headings, context, line: null });
  }
  return {
    title,
    linked: [...groups.values()],
    unlinked: [],
    provider: "wikilinks",
  };
}

export interface HighlightedPart {
  /** Raw source text (kept for matching and copy). */
  text: string;
  /** What to show: the alias for `[[Target|alias]]`, else the target basename; plain text otherwise. */
  label: string;
  /** True when this part is a wikilink (hit or not). */
  link: boolean;
  hit: boolean;
}

/** Obsidian-style display text for the inside of a `[[...]]`. */
export function wikilinkDisplayLabel(inner: string): string {
  const [reference, ...aliasParts] = inner.split("|");
  const alias = aliasParts.join("|").trim();
  if (alias) return alias;
  const [target, ...subpath] = reference!.split("#");
  const base = target!.trim().replace(/\\/g, "/").split("/").at(-1)!.replace(/\.(?:md|markdown|tldraw)$/i, "");
  const heading = subpath.join("#").trim();
  if (!base) return heading || inner.trim();
  return heading ? `${base} › ${heading}` : base;
}

function wikilinkPointsAt(inner: string, title: string): boolean {
  const reference = inner.split(/[|#]/)[0]!.trim().toLowerCase();
  const wanted = title.trim().toLowerCase();
  if (!reference || !wanted) return false;
  const withoutExtension = reference.replace(/\.(?:md|markdown)$/i, "");
  return (
    withoutExtension === wanted ||
    withoutExtension.endsWith(`/${wanted}`)
  );
}

/** Split a context line so every `[[wikilink]]` to `title` can be marked. */
export function highlightContext(text: string, title: string): HighlightedPart[] {
  const parts: HighlightedPart[] = [];
  const pattern = /!?\[\[([^\]\n]+)\]\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      const plain = text.slice(last, match.index);
      parts.push({ text: plain, label: plain, link: false, hit: false });
    }
    parts.push({
      text: match[0],
      label: wikilinkDisplayLabel(match[1]!),
      link: true,
      hit: wikilinkPointsAt(match[1]!, title),
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    const plain = text.slice(last);
    parts.push({ text: plain, label: plain, link: false, hit: false });
  }
  return parts;
}

export function countOccurrences(groups: readonly DocumentBacklinkGroup[]): number {
  return groups.reduce(
    (total, group) => total + Math.max(1, group.occurrences.length),
    0,
  );
}

export function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    if (value === null) return fallback;
    return value === "1";
  } catch {
    return fallback;
  }
}

export function writeStoredFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, quota); the toggle still works for the session.
  }
}
