// Obsidian-style "backlinks in document": rendered under the note preview so
// it scrolls with the content. Data comes from the vault-graph plugin's RPC
// (notes, canvases, threads, unlinked mentions); when that plugin is missing or
// unreachable the section falls back to wikilinks' own contextual backlinks.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { HoverPreviewBacklink } from "./hover-preview.js";
import {
  callVaultGraph,
  countOccurrences,
  DOCUMENT_BACKLINKS_COLLAPSED_KEY,
  DOCUMENT_UNLINKED_EXPANDED_KEY,
  groupPreviewBacklinks,
  groupVaultGraphBacklinks,
  highlightContext,
  noteTitleFromPath,
  readStoredFlag,
  vaultGraphTargetForOpener,
  writeStoredFlag,
  type DocumentBacklinkGroup,
  type DocumentBacklinksData,
  type VaultGraphNotePanel,
  type VaultGraphResolvedTarget,
} from "./document-backlinks-model.js";

const ACTIVE_FILE_EVENT = "bb-active-file";
const REANNOUNCE_THROTTLE_MS = 2_000;
const SAVE_REFRESH_DELAY_MS = 1_200;
const LOADING_INDICATOR_DELAY_MS = 400;

const KIND_LABEL: Record<DocumentBacklinkGroup["kind"], string> = {
  note: "note",
  canvas: "canvas",
  thread: "thread",
};

export interface DocumentBacklinksProps {
  path: string;
  source: PluginFileOpenerSource;
  /** Bump after the note's own save completes to refetch (after a short delay). */
  refreshToken: number;
  /** wikilinks' own contextual backlinks, used when vault-graph is unavailable. */
  loadFallback: () => Promise<HoverPreviewBacklink[]>;
  /** Wraps a note or canvas title in the hover-previewing file link. */
  renderSourceLink: (group: DocumentBacklinkGroup, children: ReactNode) => ReactNode;
  onOpenThread: (threadId: string) => void;
}

async function loadFromVaultGraph(
  path: string,
  source: PluginFileOpenerSource,
): Promise<DocumentBacklinksData | null> {
  const resolved = await callVaultGraph<VaultGraphResolvedTarget>(
    "resolve_target",
    vaultGraphTargetForOpener(path, source),
  );
  if (!resolved.inVault || !resolved.path || resolved.entityId === undefined) {
    return null;
  }
  const panel = await callVaultGraph<VaultGraphNotePanel>("note_panel", {
    path: resolved.path,
  });
  return groupVaultGraphBacklinks(panel);
}

function ContextLine({ text, title }: { text: string; title: string }) {
  return (
    <span className="wikilinks-document-backlink-context">
      {highlightContext(text, title).map((part, index) =>
        part.hit ? (
          <mark key={index} title={part.text}>{part.label}</mark>
        ) : part.link ? (
          <span key={index} className="wikilinks-document-backlink-link" title={part.text}>
            {part.label}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function BacklinkGroupList({
  groups,
  title,
  renderSourceLink,
  onOpenThread,
}: {
  groups: DocumentBacklinkGroup[];
  title: string;
  renderSourceLink: DocumentBacklinksProps["renderSourceLink"];
  onOpenThread: DocumentBacklinksProps["onOpenThread"];
}) {
  return (
    <ul className="wikilinks-document-backlink-list">
      {groups.map((group) => (
        <li className="wikilinks-document-backlink-group" key={group.key}>
          <div className="wikilinks-document-backlink-source">
            {group.kind === "thread" && group.threadId ? (
              <button
                type="button"
                className="wikilinks-document-backlink-thread"
                onClick={() => onOpenThread(group.threadId!)}
              >
                {group.title}
              </button>
            ) : group.target ? (
              renderSourceLink(group, group.title)
            ) : (
              <span>{group.title}</span>
            )}
            <span className="wikilinks-document-backlink-kind">
              {KIND_LABEL[group.kind]}
              {group.occurrences.length > 1
                ? ` · ${group.occurrences.length}`
                : ""}
            </span>
          </div>
          {group.occurrences.length > 0 ? (
            <ul className="wikilinks-document-backlink-occurrences">
              {group.occurrences.map((occurrence, index) => (
                <li
                  className="wikilinks-document-backlink-occurrence"
                  key={`${occurrence.line ?? "x"}-${index}`}
                >
                  {occurrence.headings.length > 0 ? (
                    <div className="wikilink-backlink-breadcrumbs">
                      {occurrence.headings.join(" › ")}
                    </div>
                  ) : null}
                  <ContextLine text={occurrence.context} title={title} />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function DocumentBacklinks({
  path,
  source,
  refreshToken,
  loadFallback,
  renderSourceLink,
  onOpenThread,
}: DocumentBacklinksProps) {
  const sourceKey = JSON.stringify(source);
  const [data, setData] = useState<DocumentBacklinksData | null>(null);
  const [showLoading, setShowLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(() =>
    readStoredFlag(DOCUMENT_BACKLINKS_COLLAPSED_KEY, false),
  );
  const [unlinkedExpanded, setUnlinkedExpanded] = useState(() =>
    readStoredFlag(DOCUMENT_UNLINKED_EXPANDED_KEY, false),
  );
  const sequence = useRef(0);
  const lastLoadAt = useRef(0);
  const loadingRef = useRef(false);
  const loadFallbackRef = useRef(loadFallback);
  loadFallbackRef.current = loadFallback;

  const load = useCallback(async () => {
    const mine = ++sequence.current;
    loadingRef.current = true;
    lastLoadAt.current = Date.now();
    const indicator = window.setTimeout(() => {
      if (mine === sequence.current) setShowLoading(true);
    }, LOADING_INDICATOR_DELAY_MS);
    let next: DocumentBacklinksData | null = null;
    try {
      next = await loadFromVaultGraph(path, JSON.parse(sourceKey));
    } catch {
      next = null;
    }
    if (mine !== sequence.current) {
      window.clearTimeout(indicator);
      return;
    }
    if (next === null) {
      try {
        const backlinks = await loadFallbackRef.current();
        next = groupPreviewBacklinks(noteTitleFromPath(path), backlinks);
      } catch {
        next = groupPreviewBacklinks(noteTitleFromPath(path), []);
      }
    }
    window.clearTimeout(indicator);
    if (mine !== sequence.current) return;
    loadingRef.current = false;
    setShowLoading(false);
    setData(next);
  }, [path, sourceKey]);

  // Initial load and reload when the file changes.
  useEffect(() => {
    setData(null);
    setShowLoading(false);
    void load();
    return () => {
      sequence.current += 1;
      loadingRef.current = false;
    };
  }, [load]);

  // After this note saves, give the vault indexer a moment and refetch.
  useEffect(() => {
    if (refreshToken === 0) return;
    const timer = window.setTimeout(() => void load(), SAVE_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [load, refreshToken]);

  // Cheap refresh triggers standing in for a cross-plugin realtime channel:
  // window focus / visibility, and the opener re-announcing this file.
  useEffect(() => {
    const maybeReload = () => {
      if (document.visibilityState === "hidden" || loadingRef.current) return;
      if (Date.now() - lastLoadAt.current < REANNOUNCE_THROTTLE_MS) return;
      void load();
    };
    const onActiveFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail;
      if (detail?.path === path) maybeReload();
    };
    window.addEventListener("focus", maybeReload);
    document.addEventListener("visibilitychange", maybeReload);
    document.addEventListener(ACTIVE_FILE_EVENT, onActiveFile);
    return () => {
      window.removeEventListener("focus", maybeReload);
      document.removeEventListener("visibilitychange", maybeReload);
      document.removeEventListener(ACTIVE_FILE_EVENT, onActiveFile);
    };
  }, [load, path]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      writeStoredFlag(DOCUMENT_BACKLINKS_COLLAPSED_KEY, !value);
      return !value;
    });
  };
  const toggleUnlinked = () => {
    setUnlinkedExpanded((value) => {
      writeStoredFlag(DOCUMENT_UNLINKED_EXPANDED_KEY, !value);
      return !value;
    });
  };

  const linkedCount = data ? countOccurrences(data.linked) : 0;
  const unlinkedCount = data ? data.unlinked.length : 0;
  const title = data?.title ?? noteTitleFromPath(path);

  return (
    <section
      className="wikilinks-document-backlinks"
      aria-label="Backlinks"
      data-provider={data?.provider ?? "loading"}
    >
      <div className="wikilinks-document-backlinks-inner">
        <div className="wikilinks-document-backlinks-header">
          <button
            type="button"
            className="wikilinks-document-backlinks-toggle"
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            <span className="wikilinks-document-backlinks-chevron" aria-hidden="true">
              {collapsed ? "▸" : "▾"}
            </span>
            <span>Linked mentions</span>
            <span className="wikilinks-document-backlinks-count">
              {data ? linkedCount : "…"}
            </span>
          </button>
        </div>
        {collapsed ? null : (
          <div className="wikilinks-document-backlinks-body">
            {data === null ? (
              showLoading ? (
                <p className="wikilinks-document-backlinks-empty">
                  Loading backlinks…
                </p>
              ) : null
            ) : data.linked.length === 0 ? (
              <p className="wikilinks-document-backlinks-empty">
                No backlinks yet
              </p>
            ) : (
              <BacklinkGroupList
                groups={data.linked}
                title={title}
                renderSourceLink={renderSourceLink}
                onOpenThread={onOpenThread}
              />
            )}
            {data && data.provider === "vault-graph" ? (
              <div className="wikilinks-document-unlinked">
                <button
                  type="button"
                  className="wikilinks-document-backlinks-toggle"
                  aria-expanded={unlinkedExpanded}
                  onClick={toggleUnlinked}
                >
                  <span
                    className="wikilinks-document-backlinks-chevron"
                    aria-hidden="true"
                  >
                    {unlinkedExpanded ? "▾" : "▸"}
                  </span>
                  <span>Unlinked mentions</span>
                  <span className="wikilinks-document-backlinks-count">
                    {unlinkedCount}
                  </span>
                </button>
                {unlinkedExpanded ? (
                  data.unlinked.length === 0 ? (
                    <p className="wikilinks-document-backlinks-empty">
                      No unlinked mentions
                    </p>
                  ) : (
                    <BacklinkGroupList
                      groups={data.unlinked}
                      title={title}
                      renderSourceLink={renderSourceLink}
                      onOpenThread={onOpenThread}
                    />
                  )
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
