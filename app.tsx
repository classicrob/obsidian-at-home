import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_FileLink as FileLink,
  UrlLink,
  useBbNavigate,
  useRpc,
  useSettings,
  type ExperimentalLiveFileTarget,
  type PluginFileOpenerProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import { useAnnounceActiveFile } from "./active-file-announce.js";
import { DocumentBacklinks } from "./document-backlinks.js";
import {
  previewTargetForOpener,
  type DocumentBacklinkGroup,
} from "./document-backlinks-model.js";
import {
  CHAT_WIKILINK_HOVER_EVENT,
  CHAT_WIKILINK_LEAVE_EVENT,
  CHAT_WIKILINK_OPEN_EVENT,
  mountChatWikilinks,
  type ChatWikilinkHoverDetail,
  type ChatWikilinkOpenDetail,
} from "./chat-wikilinks.js";
import {
  COMPOSER_WIKILINK_QUERY_EVENT,
  COMPOSER_WIKILINK_RESULTS_EVENT,
  mountComposerWikilinkAutocomplete,
  type ComposerWikilinkQueryDetail,
  type ComposerWikilinkResultsDetail,
} from "./composer-autocomplete.js";
import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  HoverPreviewCard,
  type HoverPreviewBacklink,
  type HoverPreviewData,
} from "./hover-preview.js";
import { elementRect, type HoverAnchorRect } from "./hover-types.js";
import { WikilinkMedia } from "./wikilink-media.js";
import { InstantMarkdownPreview } from "./instant-markdown-preview.js";
import { displayWikilinkLabel, parseWikilinkSubpath } from "./wikilink-markdown.js";
import { parseMarkdownDocument } from "./markdown-document.js";
import { mergeThreeWay } from "./three-way-merge.js";
import {
  clearEditorDraft,
  planDraftRestore,
  readEditorDraft,
  writeEditorDraft,
} from "./editor-draft.js";
import {
  ThinkingTrailParent,
  ThinkingTrailProvider,
  useThinkingTrail,
  useThinkingTrailParent,
} from "./thinking-trails-app.js";
import type {
  CapturedThinkingTrail,
  StoredThinkingTrail,
  StoredThinkingTrailStep,
  ThinkingTrailTarget,
} from "./thinking-trails.js";
import "./app.css";

type LiveMarkdownEditorComponent =
  typeof import("./live-markdown-editor.js")["LiveMarkdownEditor"];

interface CachedMarkdownFile {
  result: { content: string; sha256: string };
  links: HoverPreviewData["links"];
}

interface WebPreviewResult {
  url: string;
  title: string;
  siteName: string;
  content: string;
  format: "markdown" | "text";
  truncated: boolean;
}

const markdownFileCache = new Map<string, CachedMarkdownFile>();
const LIVE_MARKDOWN_REFRESH_MS = 500;
let loadedLiveMarkdownEditor: LiveMarkdownEditorComponent | null = null;
let liveMarkdownEditorPromise: Promise<LiveMarkdownEditorComponent> | null =
  null;

function loadLiveMarkdownEditor(): Promise<LiveMarkdownEditorComponent> {
  if (loadedLiveMarkdownEditor) return Promise.resolve(loadedLiveMarkdownEditor);
  liveMarkdownEditorPromise ??= import("./live-markdown-editor.js").then(
    (module) => {
      loadedLiveMarkdownEditor = module.LiveMarkdownEditor;
      return loadedLiveMarkdownEditor;
    },
  );
  return liveMarkdownEditorPromise;
}

function cacheMarkdownFile(key: string, value: CachedMarkdownFile) {
  markdownFileCache.delete(key);
  markdownFileCache.set(key, value);
  if (markdownFileCache.size > 24) {
    markdownFileCache.delete(markdownFileCache.keys().next().value!);
  }
}

function fileLabel(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").at(-1) ?? filePath;
  try {
    return decodeURIComponent(name).replace(/\.(?:md|markdown)$/i, "");
  } catch {
    return name.replace(/\.(?:md|markdown)$/i, "");
  }
}

function openerTrailTarget(
  path: string,
  source: PluginFileOpenerProps["source"],
): ThinkingTrailTarget | null {
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

function TrackedWikilinkFileOpener(props: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const record = useCallback(
    (trail: CapturedThinkingTrail) => {
      void rpc.call("record_thinking_trail", { trail }).catch(() => undefined);
    },
    [rpc],
  );
  return (
    <ThinkingTrailProvider
      threadId={props.source.threadId}
      projectId={props.source.projectId}
      originKind="file"
      rootLabel={fileLabel(props.path)}
      rootTarget={openerTrailTarget(props.path, props.source)}
      record={record}
    >
      <WikilinkFileOpener {...props} />
    </ThinkingTrailProvider>
  );
}

function absoluteWebUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function webTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function webHoverData(preview: WebPreviewResult | null): HoverPreviewData | null {
  return preview
    ? {
        content: preview.content,
        imageDataUrl: null,
        backlinks: null,
        truncated: preview.truncated,
        links: [],
      }
    : null;
}

function renderWebLink(url: string, children: ReactNode) {
  return (
    <PreviewingUrlLink url={url}>
      {children}
    </PreviewingUrlLink>
  );
}

function PreviewingUrlLink({
  url,
  children,
  ...props
}: {
  url: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target">) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [anchor, setAnchor] = useState<HoverAnchorRect | null>(null);
  const [preview, setPreview] = useState<WebPreviewResult | null>(null);
  const [portalContainer, setPortalContainer] = useState<Element | null>(null);
  const [loading, setLoading] = useState(false);
  const cached = useRef<WebPreviewResult | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const requestSequence = useRef(0);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const hide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      setAnchor(null);
      closeTimer.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer]);
  const show = useCallback(
    (element: Element, delay: number) => {
      clearOpenTimer();
      clearCloseTimer();
      openTimer.current = window.setTimeout(() => {
        setPortalContainer(
          element.closest<Element>("[data-wikilink-hover-preview]"),
        );
        setAnchor(elementRect(element));
        openTimer.current = null;
        if (cached.current) {
          setPreview(cached.current);
          setLoading(false);
          return;
        }
        setLoading(true);
        const sequence = ++requestSequence.current;
        void rpc.call("preview_url", { url }).then(
          (result) => {
            if (requestSequence.current !== sequence) return;
            cached.current = result;
            setPreview(result);
            setLoading(false);
          },
          () => {
            if (requestSequence.current !== sequence) return;
            setPreview(null);
            setLoading(false);
          },
        );
      }, delay);
    },
    [clearCloseTimer, clearOpenTimer, rpc, url],
  );
  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
      requestSequence.current += 1;
    },
    [clearCloseTimer, clearOpenTimer],
  );

  const renderNestedWebLink = useCallback(
    (href: string, nestedChildren: ReactNode) => {
      const resolved = absoluteWebUrl(href, preview?.url ?? url);
      return resolved ? (
        <PreviewingUrlLink url={resolved}>{nestedChildren}</PreviewingUrlLink>
      ) : (
        <span className="wikilink-standard">{nestedChildren}</span>
      );
    },
    [preview?.url, url],
  );
  const openUrl = preview?.url ?? url;
  return (
    <>
      <UrlLink
        {...props}
        href={url}
        className="wikilink-standard"
        onPointerEnter={(event) => show(event.currentTarget, HOVER_OPEN_DELAY_MS)}
        onPointerLeave={hide}
        onFocus={(event) => show(event.currentTarget, 0)}
        onBlur={hide}
      >
        {children}
      </UrlLink>
      <HoverPreviewCard
        anchor={anchor}
        title={preview?.title ?? webTitle(url)}
        preview={webHoverData(preview)}
        loading={loading}
        onOpen={() => navigate.openUrl(openUrl)}
        onPointerEnter={clearCloseTimer}
        onPointerLeave={hide}
        renderUrlLink={renderNestedWebLink}
        contentKind="web"
        openLabel="Open page"
        footerLabel={`Excerpt from ${preview?.siteName ?? webTitle(url)}`}
        portalContainer={portalContainer}
      />
    </>
  );
}

function renderBacklinkNoteLink(
  backlink: HoverPreviewBacklink,
  reference: string,
  children: ReactNode,
) {
  const link = backlink.links.find((candidate) => candidate.reference === reference);
  return link ? (
    <PreviewingFileLink
      reference={reference}
      target={link.target}
      exists={link.exists}
      relation="backlink"
    >
      {children}
    </PreviewingFileLink>
  ) : (
    <span className="wikilink wikilink-unresolved">{children}</span>
  );
}

function PreviewingFileLink({
  reference,
  target,
  exists,
  relation = "link",
  children,
  ...props
}: {
  reference: string;
  target: ExperimentalLiveFileTarget;
  exists: boolean;
  relation?: "link" | "backlink";
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target">) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const trail = useThinkingTrail();
  const trailParent = useThinkingTrailParent();
  const [anchor, setAnchor] = useState<HoverAnchorRect | null>(null);
  const [preview, setPreview] = useState<HoverPreviewData | null>(null);
  const [portalContainer, setPortalContainer] = useState<Element | null>(null);
  const [loading, setLoading] = useState(false);
  const previewCache = useRef(new Map<"note" | "backlinks", HoverPreviewData>());
  const activeElement = useRef<Element | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const visitRef = useRef<string | null>(null);
  const [visitLocalId, setVisitLocalId] = useState<string | null>(null);

  const endTrailVisit = useCallback(() => {
    if (visitRef.current) trail?.endVisit(visitRef.current);
    visitRef.current = null;
    setVisitLocalId(null);
  }, [trail]);
  const markClickThrough = useCallback(() => {
    let localId = visitRef.current;
    if (!localId) {
      localId =
        trail?.beginVisit({
          label: displayWikilinkLabel(reference, undefined),
          target,
          relation,
          previewMode: "note",
          parentLocalId: trailParent,
        }) ?? null;
    }
    if (!localId) return;
    trail?.interact(localId, true);
    trail?.finish("context-changed");
  }, [reference, relation, target, trail, trailParent]);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const hide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      endTrailVisit();
      setAnchor(null);
      closeTimer.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, endTrailVisit]);
  const show = useCallback(
    (element: Element, delay: number, showBacklinks = false) => {
      clearOpenTimer();
      clearCloseTimer();
      openTimer.current = window.setTimeout(() => {
        endTrailVisit();
        const mode = showBacklinks ? "backlinks" : "note";
        const visitLocalId =
          trail?.beginVisit({
            label: displayWikilinkLabel(reference, undefined),
            target,
            relation,
            previewMode: mode,
            parentLocalId: trailParent,
          }) ?? null;
        visitRef.current = visitLocalId;
        setVisitLocalId(visitLocalId);
        setPortalContainer(
          element.closest<Element>("[data-wikilink-hover-preview]"),
        );
        setAnchor(elementRect(element));
        openTimer.current = null;
        const cached = previewCache.current.get(mode);
        if (cached) {
          if (visitLocalId) trail?.markLoaded(visitLocalId);
          setPreview(cached);
          setLoading(false);
          return;
        }
        setPreview(null);
        setLoading(true);
        const sequence = ++requestSequence.current;
        void rpc.call("preview_file", { target, backlinks: showBacklinks }).then(
          (result) => {
            if (requestSequence.current === sequence) {
              if (visitLocalId) trail?.markLoaded(visitLocalId);
              previewCache.current.set(mode, result);
              setPreview(result);
              setLoading(false);
            }
          },
          () => {
            if (requestSequence.current === sequence) {
              endTrailVisit();
              setPreview({
                content: null,
                imageDataUrl: null,
                backlinks: showBacklinks ? [] : null,
                truncated: false,
                links: [],
              });
              setLoading(false);
            }
          },
        );
      }, delay);
    },
    [
      clearCloseTimer,
      clearOpenTimer,
      endTrailVisit,
      reference,
      relation,
      rpc,
      target,
      trail,
      trailParent,
    ],
  );

  useEffect(() => {
    const onModifierChange = (event: KeyboardEvent) => {
      if (event.key !== "Meta" || !activeElement.current) return;
      show(activeElement.current, 0, event.type === "keydown");
    };
    window.addEventListener("keydown", onModifierChange);
    window.addEventListener("keyup", onModifierChange);
    return () => {
      window.removeEventListener("keydown", onModifierChange);
      window.removeEventListener("keyup", onModifierChange);
    };
  }, [show]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
      endTrailVisit();
      requestSequence.current += 1;
    },
    [clearCloseTimer, clearOpenTimer, endTrailVisit],
  );

  const title = displayWikilinkLabel(reference, undefined);
  const previewLinkIndex = useMemo(
    () => new Map((preview?.links ?? []).map((link) => [link.reference, link])),
    [preview],
  );
  const renderNestedNoteLink = useCallback(
    (nestedReference: string, nestedChildren: ReactNode) => {
      const link = previewLinkIndex.get(nestedReference);
      if (!link) {
        return (
          <span className="wikilink wikilink-unresolved">
            {nestedChildren}
          </span>
        );
      }
      return (
        <PreviewingFileLink
          reference={nestedReference}
          target={link.target}
          exists={link.exists}
        >
          {nestedChildren}
        </PreviewingFileLink>
      );
    },
    [previewLinkIndex],
  );
  return (
    <>
      <FileLink
        {...props}
        target={target}
        className={exists ? "wikilink" : "wikilink wikilink-unresolved"}
        title={
          exists
            ? `Open ${reference}`
            : `Open inferred path for missing note: ${reference}`
        }
        onPointerEnter={(event) => {
          activeElement.current = event.currentTarget;
          show(event.currentTarget, HOVER_OPEN_DELAY_MS, event.metaKey);
        }}
        onPointerLeave={() => {
          activeElement.current = null;
          hide();
        }}
        onFocus={(event) => {
          activeElement.current = event.currentTarget;
          show(event.currentTarget, 0, false);
        }}
        onBlur={() => {
          activeElement.current = null;
          hide();
        }}
        onClick={(event) => {
          props.onClick?.(event);
          if (!event.defaultPrevented) markClickThrough();
        }}
      >
        {children}
      </FileLink>
      <ThinkingTrailParent localId={visitLocalId}>
        <HoverPreviewCard
          anchor={anchor}
          title={title}
          preview={preview}
          loading={loading}
          focus={parseWikilinkSubpath(reference)}
          onOpen={() => {
            markClickThrough();
            navigate.experimental_openFilePreview({ target, location: null });
          }}
          onInteract={() => {
            if (visitRef.current) trail?.interact(visitRef.current);
          }}
          onPointerEnter={clearCloseTimer}
          onPointerLeave={hide}
          renderNoteLink={renderNestedNoteLink}
          renderBacklinkLink={(backlink, backlinkChildren) => (
            <PreviewingFileLink
              reference={backlink.sourceTitle}
              target={backlink.target}
              exists
              relation="backlink"
            >
              {backlinkChildren}
            </PreviewingFileLink>
          )}
          renderBacklinkNoteLink={renderBacklinkNoteLink}
          renderUrlLink={renderWebLink}
          portalContainer={portalContainer}
        />
      </ThinkingTrailParent>
    </>
  );
}

interface EditorHoverState {
  reference: string;
  anchor: HoverAnchorRect;
  preview: HoverPreviewData | null;
  loading: boolean;
  target: ExperimentalLiveFileTarget | null;
}

function WikilinkFileOpener({ path, source, Original }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const settings = useSettings();
  const documentBacklinksEnabled = settings.values?.documentBacklinks !== false;
  const trail = useThinkingTrail();
  const trailParent = useThinkingTrailParent();
  const openerSource = useMemo(
    () => ({
      kind: source.kind,
      threadId: source.threadId,
      environmentId: source.environmentId,
      projectId: source.projectId,
      ...(source.experimental_hostId
        ? { experimental_hostId: source.experimental_hostId }
        : {}),
    }),
    [
      source.environmentId,
      source.experimental_hostId,
      source.kind,
      source.projectId,
      source.threadId,
    ],
  );
  const cacheKey = useMemo(
    () => JSON.stringify([path, openerSource]),
    [openerSource, path],
  );
  const activeFileRoot = useRef<HTMLDivElement>(null);
  useAnnounceActiveFile("wikilinks", path, openerSource, activeFileRoot);
  // Identifies this note's editor to the shared composer autocomplete script.
  const editorBridgeId = useId();
  // Targets for references that are not (yet) links in this document, such as
  // autocomplete suggestions the user previewed or opened.
  const externalTargets = useRef(new Map<string, ExperimentalLiveFileTarget>());
  const initiallyCached = markdownFileCache.get(cacheKey);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof rpc.call<"open_markdown">>
  > | null>(initiallyCached?.result ?? null);
  const [links, setLinks] = useState<HoverPreviewData["links"]>(
    initiallyCached?.links ?? [],
  );
  const [failed, setFailed] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "unsaved" | "saving"
  >("saved");
  const [LiveMarkdownEditor, setLiveMarkdownEditor] =
    useState<LiveMarkdownEditorComponent | null>(
      () => loadedLiveMarkdownEditor,
    );
  const [editRequested, setEditRequested] = useState(false);
  // Readiness is tracked per editor instance (its React key) so a load
  // effect running after a fresh editor mounts cannot strand it "preparing".
  const editorKey = `${path}:${reloadNonce}`;
  const [readyEditorKey, setReadyEditorKey] = useState<string | null>(null);
  const editorReady = readyEditorKey === editorKey;
  const [focusRequest, setFocusRequest] = useState<{
    left: number;
    top: number;
    sequence: number;
  } | null>(null);
  const [selectionRequest, setSelectionRequest] = useState<{
    from: number;
    to: number;
    sequence: number;
  } | null>(null);
  const [hover, setHover] = useState<EditorHoverState | null>(null);
  const [backlinksRefresh, setBacklinksRefresh] = useState(0);
  const markdownRef = useRef("");
  const savedRef = useRef("");
  const shaRef = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savingRef = useRef(false);
  const queuedSaveRef = useRef(false);
  const conflictRef = useRef(false);
  const fileReadSequence = useRef(0);
  const openingRef = useRef(false);
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const selectionRef = useRef<{ from: number; to: number } | null>(null);
  const draftTimer = useRef<number | null>(null);
  const conflictRetriesRef = useRef(0);
  const hoverCache = useRef(new Map<string, HoverPreviewData>());
  const hoverOpenTimer = useRef<number | null>(null);
  const hoverCloseTimer = useRef<number | null>(null);
  const hoverSequence = useRef(0);
  const editorVisitRef = useRef<string | null>(null);
  const editorVisitReferenceRef = useRef<string | null>(null);
  const [editorVisitLocalId, setEditorVisitLocalId] = useState<string | null>(
    null,
  );

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    setSaveStatus("unsaved");
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void saveRef.current();
    }, 650);
  }, []);

  // Unsaved text is parked per note so a plugin bundle reload, which remounts
  // this view, can hand it back instead of dropping it.
  const writeDraftNow = useCallback(() => {
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    if (markdownRef.current === savedRef.current) {
      clearEditorDraft(cacheKey);
      return;
    }
    writeEditorDraft(cacheKey, {
      baseSha: shaRef.current,
      base: savedRef.current,
      markdown: markdownRef.current,
      editing: true,
      selection: selectionRef.current,
      at: Date.now(),
    });
  }, [cacheKey]);
  const scheduleDraftWrite = useCallback(() => {
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(writeDraftNow, 100);
  }, [writeDraftNow]);

  /**
   * Takes a newer copy of the file into the view. With no local edits it
   * simply replaces the content; with unsaved edits it merges them on top of
   * the new file line by line and saves the result, only falling back to the
   * conflict banner when both sides changed the same lines.
   */
  const adoptExternalChange = useCallback(
    (next: { content: string; sha256: string }): boolean => {
      const base = savedRef.current;
      const ours = markdownRef.current;
      setFailed(false);
      setSaveError(null);
      setLinks([]);
      if (ours === base) {
        markdownRef.current = next.content;
        savedRef.current = next.content;
        shaRef.current = next.sha256;
        setSaveStatus("saved");
        cacheMarkdownFile(cacheKey, { result: next, links: [] });
        setResult({ content: next.content, sha256: next.sha256 });
        clearEditorDraft(cacheKey);
        return true;
      }
      const merge = mergeThreeWay(base, ours, next.content);
      if (!merge.ok) {
        conflictRef.current = true;
        setConflict(true);
        setSaveStatus("unsaved");
        return false;
      }
      savedRef.current = next.content;
      shaRef.current = next.sha256;
      markdownRef.current = merge.merged;
      cacheMarkdownFile(cacheKey, {
        result: { content: next.content, sha256: next.sha256 },
        links: [],
      });
      setResult({ content: merge.merged, sha256: next.sha256 });
      if (merge.merged === next.content) {
        setSaveStatus("saved");
        clearEditorDraft(cacheKey);
      } else {
        scheduleSave();
        writeDraftNow();
      }
      return true;
    },
    [cacheKey, scheduleSave, writeDraftNow],
  );
  const adoptExternalRef = useRef(adoptExternalChange);
  adoptExternalRef.current = adoptExternalChange;

  useEffect(() => {
    let active = true;
    const requestSequence = ++fileReadSequence.current;
    openingRef.current = true;
    const cached = markdownFileCache.get(cacheKey);
    setResult(cached?.result ?? null);
    setLinks(cached?.links ?? []);
    setFailed(false);
    setConflict(false);
    conflictRef.current = false;
    setSaveError(null);
    setRefreshFailed(false);
    setSaveStatus("saved");
    setEditRequested(false);
    setFocusRequest(null);
    setSelectionRequest(null);
    conflictRetriesRef.current = 0;
    markdownRef.current = cached?.result.content ?? "";
    savedRef.current = cached?.result.content ?? "";
    shaRef.current = cached?.result.sha256 ?? null;
    rpc.call("open_markdown", { path, source: openerSource, createIfMissing: true }).then(
      (next) => {
        if (!active || requestSequence !== fileReadSequence.current) return;
        openingRef.current = false;
        if (shaRef.current && shaRef.current !== next.sha256) {
          setEditRequested(false);
        }
        savedRef.current = next.content;
        shaRef.current = next.sha256;
        cacheMarkdownFile(cacheKey, {
          result: next,
          links: cached?.links ?? [],
        });
        // A draft left by a previous mount (the plugin bundle was reloaded
        // mid-edit) comes back as unsaved text, merged if the file moved on.
        const draft = readEditorDraft(cacheKey);
        const plan = draft
          ? planDraftRestore(draft, next)
          : ({ kind: "none" } as const);
        if (plan.kind === "none") {
          if (draft) clearEditorDraft(cacheKey);
          markdownRef.current = next.content;
          setResult(next);
          if (next.created) {
            setEditRequested(true);
            setFocusRequest({ left: 0, top: 0, sequence: Date.now() });
          }
          return;
        }
        setEditRequested(true);
        if (draft?.selection) {
          setSelectionRequest({ ...draft.selection, sequence: Date.now() });
        }
        if (plan.kind === "conflict") {
          markdownRef.current = draft!.markdown;
          conflictRef.current = true;
          setConflict(true);
          setSaveStatus("unsaved");
          setResult({ content: draft!.markdown, sha256: next.sha256 });
          return;
        }
        markdownRef.current = plan.markdown;
        setResult({ content: plan.markdown, sha256: next.sha256 });
        scheduleSave();
        writeDraftNow();
      },
      () => {
        if (active && requestSequence === fileReadSequence.current) {
          openingRef.current = false;
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [cacheKey, openerSource, path, reloadNonce, rpc, scheduleSave, writeDraftNow]);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    let inFlight = false;

    const schedule = (delay = LIVE_MARKDOWN_REFRESH_MS) => {
      if (!active) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, delay);
    };

    const refresh = async () => {
      timer = null;
      if (!active || inFlight) return;
      const knownSha256 = shaRef.current;
      // Local edits do not pause the poll: an external change is merged on
      // top of them so it still shows up right away.
      if (
        document.visibilityState === "hidden" ||
        openingRef.current ||
        !knownSha256 ||
        savingRef.current ||
        conflictRef.current
      ) {
        schedule();
        return;
      }

      const requestSequence = ++fileReadSequence.current;
      inFlight = true;
      try {
        const next = await rpc.call("refresh_markdown", {
          path,
          source: openerSource,
          knownSha256,
        });
        if (
          !active ||
          requestSequence !== fileReadSequence.current ||
          shaRef.current !== knownSha256
        ) {
          return;
        }
        setRefreshFailed(false);
        if (!next.changed) return;
        // A save that started meanwhile will see this change as a conflict
        // and reconcile it itself.
        if (savingRef.current || conflictRef.current) return;
        adoptExternalRef.current({ content: next.content, sha256: next.sha256 });
      } catch {
        if (active && requestSequence === fileReadSequence.current) {
          setRefreshFailed(true);
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const refreshNow = () => {
      if (!inFlight && document.visibilityState !== "hidden") schedule(0);
    };

    schedule();
    document.addEventListener("visibilitychange", refreshNow);
    window.addEventListener("focus", refreshNow);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshNow);
      window.removeEventListener("focus", refreshNow);
    };
  }, [cacheKey, openerSource, path, reloadNonce, rpc]);

  const resolveLinksForContent = useCallback(
    (content: string) => {
      void rpc
        .call("resolve_markdown_links", {
          path,
          source: openerSource,
          content,
        })
        .then(({ links: nextLinks }) => {
          if (markdownRef.current !== content) return;
          setLinks(nextLinks);
          setResult((current) => {
            if (current) {
              cacheMarkdownFile(cacheKey, {
                result: current,
                links: nextLinks,
              });
            }
            return current;
          });
        })
        .catch(() => undefined);
    },
    [cacheKey, openerSource, path, rpc],
  );

  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(
      () => resolveLinksForContent(result.content),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [resolveLinksForContent, result]);

  useEffect(() => {
    if (!result || LiveMarkdownEditor) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void loadLiveMarkdownEditor().then((component) => {
        if (active) setLiveMarkdownEditor(() => component);
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [LiveMarkdownEditor, result]);

  const save = useCallback(
    async (force = false) => {
      if (savingRef.current) {
        queuedSaveRef.current = true;
        return;
      }
      if (conflictRef.current && !force) return;
      if (!force && markdownRef.current === savedRef.current) {
        setSaveStatus("saved");
        return;
      }
      savingRef.current = true;
      queuedSaveRef.current = false;
      setSaveStatus("saving");
      setSaveError(null);
      const content = markdownRef.current;
      try {
        const saved = await rpc.call("save_markdown", {
          path,
          source: openerSource,
          content,
          ...(!force && shaRef.current
            ? { expectedSha256: shaRef.current }
            : {}),
        });
        if (saved.outcome === "conflict") {
          // The file moved on under us. Fetch it and merge our text on top
          // rather than blocking on the banner; the merged text saves next.
          const knownSha256 = shaRef.current;
          if (knownSha256 && conflictRetriesRef.current < 3) {
            conflictRetriesRef.current += 1;
            const latest = await rpc.call("refresh_markdown", {
              path,
              source: openerSource,
              knownSha256,
            });
            if (shaRef.current !== knownSha256 || conflictRef.current) return;
            if (latest.changed) {
              if (adoptExternalRef.current(latest)) queuedSaveRef.current = false;
              return;
            }
            // Our sha already matches the file: retry the save once more.
            queuedSaveRef.current = true;
            return;
          }
          conflictRef.current = true;
          setConflict(true);
          setSaveStatus("unsaved");
          return;
        }
        conflictRetriesRef.current = 0;
        savedRef.current = content;
        shaRef.current = saved.sha256;
        conflictRef.current = false;
        setConflict(false);
        // Echo back what the editor shows now, not the snapshot that was
        // saved; keystrokes typed during the save must not be rolled back.
        setResult((current) => {
          const next = current
            ? { content: markdownRef.current, sha256: saved.sha256 }
            : current;
          if (next) cacheMarkdownFile(cacheKey, { result: next, links });
          return next;
        });
        if (markdownRef.current === content) {
          setSaveStatus("saved");
          clearEditorDraft(cacheKey);
        } else {
          setSaveStatus("unsaved");
        }
        setBacklinksRefresh((value) => value + 1);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error));
        setSaveStatus("unsaved");
      } finally {
        savingRef.current = false;
        if (queuedSaveRef.current && !conflictRef.current) {
          queuedSaveRef.current = false;
          window.setTimeout(() => void saveRef.current(), 0);
        }
      }
    },
    [cacheKey, links, openerSource, path, resolveLinksForContent, rpc],
  );
  saveRef.current = save;
  const writeDraftRef = useRef(writeDraftNow);
  writeDraftRef.current = writeDraftNow;

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      // Park unsaved text first: the save below may not complete if this
      // unmount is the plugin bundle being reloaded.
      writeDraftRef.current();
      void saveRef.current();
    },
    [],
  );

  const linkIndex = useMemo(
    () => new Map(links.map((link) => [link.reference, link])),
    [links],
  );
  const clearHoverOpen = useCallback(() => {
    if (hoverOpenTimer.current !== null) {
      window.clearTimeout(hoverOpenTimer.current);
    }
    hoverOpenTimer.current = null;
  }, []);
  const clearHoverClose = useCallback(() => {
    if (hoverCloseTimer.current !== null) {
      window.clearTimeout(hoverCloseTimer.current);
    }
    hoverCloseTimer.current = null;
  }, []);
  const endEditorTrailVisit = useCallback(() => {
    if (editorVisitRef.current) trail?.endVisit(editorVisitRef.current);
    editorVisitRef.current = null;
    editorVisitReferenceRef.current = null;
    setEditorVisitLocalId(null);
  }, [trail]);
  const hideHover = useCallback(() => {
    clearHoverOpen();
    clearHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      endEditorTrailVisit();
      setHover(null);
      hoverCloseTimer.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearHoverClose, clearHoverOpen, endEditorTrailVisit]);
  const showHover = useCallback(
    (reference: string, element: HTMLElement, showBacklinks = false) => {
      const link = linkIndex.get(reference);
      if (!link) return;
      clearHoverOpen();
      clearHoverClose();
      hoverOpenTimer.current = window.setTimeout(() => {
        endEditorTrailVisit();
        const anchor = elementRect(element);
        const cacheKey = `${showBacklinks ? "backlinks" : "note"}\0${reference}`;
        const visitLocalId =
          trail?.beginVisit({
            label: displayWikilinkLabel(reference, undefined),
            target: link.target,
            relation: "link",
            previewMode: showBacklinks ? "backlinks" : "note",
            parentLocalId: trailParent,
          }) ?? null;
        editorVisitRef.current = visitLocalId;
        editorVisitReferenceRef.current = reference;
        setEditorVisitLocalId(visitLocalId);
        const cached = hoverCache.current.get(cacheKey);
        if (cached) {
          if (visitLocalId) trail?.markLoaded(visitLocalId);
          setHover({
            reference,
            anchor,
            preview: cached,
            loading: false,
            target: link.target,
          });
          return;
        }
        setHover({
          reference,
          anchor,
          preview: null,
          loading: true,
          target: link.target,
        });
        const sequence = ++hoverSequence.current;
        void rpc
          .call("preview_file", {
            target: link.target,
            backlinks: showBacklinks,
          })
          .then(
          (preview) => {
            hoverCache.current.set(cacheKey, preview);
            if (hoverSequence.current === sequence) {
              if (visitLocalId) trail?.markLoaded(visitLocalId);
              setHover({
                reference,
                anchor,
                preview,
                loading: false,
                target: link.target,
              });
            }
          },
          () => {
            if (hoverSequence.current === sequence) {
              endEditorTrailVisit();
              setHover({
                reference,
                anchor,
                preview: {
                  content: null,
                  imageDataUrl: null,
                  backlinks: showBacklinks ? [] : null,
                  truncated: false,
                  links: [],
                },
                loading: false,
                target: link.target,
              });
            }
          },
        );
      }, HOVER_OPEN_DELAY_MS);
    },
    [
      clearHoverClose,
      clearHoverOpen,
      endEditorTrailVisit,
      linkIndex,
      rpc,
      trail,
      trailParent,
    ],
  );
  useEffect(
    () => () => {
      clearHoverOpen();
      clearHoverClose();
      endEditorTrailVisit();
      hoverSequence.current += 1;
    },
    [clearHoverClose, clearHoverOpen, endEditorTrailVisit],
  );

  // Backlinks-in-document fallback: wikilinks' own contextual backlinks when
  // the vault-graph plugin cannot answer for this file.
  const loadFallbackBacklinks = useCallback(async () => {
    const target = previewTargetForOpener(path, openerSource);
    if (!target) return [];
    const preview = await rpc.call("preview_file", { target, backlinks: true });
    return preview.backlinks ?? [];
  }, [openerSource, path, rpc]);
  const renderBacklinkSourceLink = useCallback(
    (group: DocumentBacklinkGroup, children: ReactNode) =>
      group.target ? (
        <PreviewingFileLink
          reference={group.title}
          target={group.target}
          exists
          relation="backlink"
        >
          {children}
        </PreviewingFileLink>
      ) : (
        <span>{children}</span>
      ),
    [],
  );

  const openReference = useCallback(
    (reference: string) => {
      const target =
        linkIndex.get(reference)?.target ??
        externalTargets.current.get(reference) ??
        null;
      if (!target) {
        // Not a link in this document yet (for example a suggestion picked
        // from autocomplete); resolve it against the note's workspace.
        void rpc
          .call("resolve_chat_wikilink", {
            source: openerSource,
            path,
            reference,
          })
          .then(({ target: resolved }) => {
            if (!resolved) {
              toast.error("That note link has not resolved yet.");
              return;
            }
            externalTargets.current.set(reference, resolved);
            navigate.experimental_openFilePreview({
              target: resolved,
              location: null,
            });
          })
          .catch(() => toast.error("Could not resolve that note link."));
        return;
      }
      if (
        editorVisitRef.current &&
        editorVisitReferenceRef.current === reference
      ) {
        trail?.interact(editorVisitRef.current, true);
        trail?.finish("context-changed");
      } else {
        const localId = trail?.beginVisit({
          label: displayWikilinkLabel(reference, undefined),
          target,
          relation: "link",
          previewMode: "note",
          parentLocalId: trailParent,
        });
        if (localId) {
          trail?.interact(localId, true);
          trail?.finish("context-changed");
        }
      }
      navigate.experimental_openFilePreview({ target, location: null });
    },
    [linkIndex, navigate, openerSource, path, rpc, trail, trailParent],
  );
  const hoverLinkIndex = useMemo(
    () => new Map((hover?.preview?.links ?? []).map((link) => [link.reference, link])),
    [hover?.preview?.links],
  );
  const renderNestedNoteLink = useCallback(
    (reference: string, children: ReactNode) => {
      const link = hoverLinkIndex.get(reference);
      return link ? (
        <PreviewingFileLink
          reference={reference}
          target={link.target}
          exists={link.exists}
        >
          {children}
        </PreviewingFileLink>
      ) : (
        <span className="wikilink wikilink-unresolved">{children}</span>
      );
    },
    [hoverLinkIndex],
  );
  const renderPreviewNoteLink = useCallback(
    (reference: string, children: ReactNode) => {
      const link = linkIndex.get(reference);
      return link ? (
        <PreviewingFileLink
          reference={reference}
          target={link.target}
          exists={link.exists}
        >
          {children}
        </PreviewingFileLink>
      ) : (
        <span className="wikilink wikilink-unresolved">{children}</span>
      );
    },
    [linkIndex],
  );
  // Wikilinks typed inside this note: the composer autocomplete content script
  // sends queries, suggestion hovers and open requests tagged with this
  // editor's bridge id, mirroring what the chat bridge does for the composer.
  useEffect(() => {
    const bridgeId = editorBridgeId;
    const onQuery = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ComposerWikilinkQueryDetail> | null;
      if (
        detail?.bridgeId !== bridgeId ||
        typeof detail.requestId !== "number" ||
        typeof detail.query !== "string"
      ) {
        return;
      }
      const requestId = detail.requestId;
      const respond = (
        suggestions: ComposerWikilinkResultsDetail["suggestions"],
      ) => {
        window.dispatchEvent(
          new CustomEvent<ComposerWikilinkResultsDetail>(
            COMPOSER_WIKILINK_RESULTS_EVENT,
            { detail: { bridgeId, requestId, suggestions } },
          ),
        );
      };
      void rpc
        .call("autocomplete_wikilinks", {
          source: openerSource,
          path,
          query: detail.query,
        })
        .then(respond, () => respond([]));
    };
    const onHover = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ChatWikilinkHoverDetail> | null;
      const anchor = detail?.anchor;
      if (
        detail?.bridgeId !== bridgeId ||
        typeof detail.reference !== "string" ||
        detail.reference.trim() === "" ||
        !anchor ||
        detail.web
      ) {
        return;
      }
      const reference = detail.reference;
      const showBacklinks = detail.backlinks === true;
      clearHoverOpen();
      clearHoverClose();
      hoverOpenTimer.current = window.setTimeout(
        () => {
          endEditorTrailVisit();
          const cacheKey = `${showBacklinks ? "backlinks" : "note"}\0${reference}`;
          const knownTarget = externalTargets.current.get(reference) ?? null;
          const cached = hoverCache.current.get(cacheKey);
          if (cached) {
            setHover({
              reference,
              anchor,
              preview: cached,
              loading: false,
              target: knownTarget,
            });
            return;
          }
          setHover({
            reference,
            anchor,
            preview: null,
            loading: true,
            target: knownTarget,
          });
          const sequence = ++hoverSequence.current;
          void rpc
            .call("preview_chat_wikilink", {
              source: openerSource,
              path,
              reference,
              backlinks: showBacklinks,
            })
            .then(
              (result) => {
                if (result.target) {
                  externalTargets.current.set(reference, result.target);
                }
                const preview = {
                  content: result.content,
                  imageDataUrl: result.imageDataUrl,
                  backlinks: result.backlinks,
                  truncated: result.truncated,
                  links: result.links,
                };
                hoverCache.current.set(cacheKey, preview);
                if (hoverSequence.current !== sequence) return;
                setHover({
                  reference,
                  anchor,
                  preview,
                  loading: false,
                  target: result.target,
                });
              },
              () => {
                if (hoverSequence.current !== sequence) return;
                setHover({
                  reference,
                  anchor,
                  preview: {
                    content: null,
                    imageDataUrl: null,
                    backlinks: showBacklinks ? [] : null,
                    truncated: false,
                    links: [],
                  },
                  loading: false,
                  target: knownTarget,
                });
              },
            );
        },
        detail.immediate ? 0 : HOVER_OPEN_DELAY_MS,
      );
    };
    const onLeave = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ChatWikilinkOpenDetail> | null;
      if (detail?.bridgeId === bridgeId) hideHover();
    };
    const onOpen = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ChatWikilinkOpenDetail> | null;
      if (
        detail?.bridgeId !== bridgeId ||
        typeof detail.reference !== "string" ||
        detail.reference.trim() === ""
      ) {
        return;
      }
      openReference(detail.reference);
    };
    window.addEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    window.addEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
    window.addEventListener(CHAT_WIKILINK_LEAVE_EVENT, onLeave);
    window.addEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
      window.removeEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
      window.removeEventListener(CHAT_WIKILINK_LEAVE_EVENT, onLeave);
      window.removeEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    };
  }, [
    clearHoverClose,
    clearHoverOpen,
    editorBridgeId,
    endEditorTrailVisit,
    hideHover,
    openReference,
    openerSource,
    path,
    rpc,
  ]);

  const renderPreviewMedia = useCallback(
    (reference: string, alias: string) => <WikilinkMedia reference={reference} alias={alias} path={path} source={openerSource} />,
    [path, openerSource],
  );

  const requestEdit = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      event.target instanceof Element &&
      event.target.closest("a, button, input, textarea, select, label, video, audio, img, [data-wikilink-media]")
    ) {
      return;
    }
    setFocusRequest((current) => ({
      left: event.clientX,
      top: event.clientY,
      sequence: (current?.sequence ?? 0) + 1,
    }));
    setEditRequested(true);
  }, []);

  if (failed) return <Original />;
  if (!result) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading Markdown…
      </div>
    );
  }
  const { frontmatterRows } = parseMarkdownDocument(result.content);
  const editing = editRequested && editorReady;
  return (
    <div className="wikilinks-editor-shell" ref={activeFileRoot}>
      <div className="wikilinks-savebar" aria-live="polite" data-bb-preview-file={JSON.stringify({ path, source })}>
        <span>{editing ? "Editing" : "Live preview"}</span>
        <span>
          {editRequested && !editorReady
            ? "Preparing editor…"
            : !editing
              ? "Click text to edit"
              : saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "unsaved"
                  ? "Unsaved changes"
                  : "Saved"}
        </span>
      </div>
      {refreshFailed ? (
        <div className="wikilinks-editor-alert" role="status">
          Live updates interrupted. Retrying…
        </div>
      ) : null}
      {conflict ? (
        <div className="wikilinks-editor-alert" role="alert">
          <span>This note changed on disk.</span>
          <button
            type="button"
            onClick={() => {
              clearEditorDraft(cacheKey);
              setReloadNonce((value) => value + 1);
            }}
          >
            Reload
          </button>
          <button type="button" onClick={() => void save(true)}>
            Overwrite
          </button>
        </div>
      ) : null}
      {saveError ? (
        <div className="wikilinks-editor-alert wikilinks-editor-error" role="alert">
          {saveError}
        </div>
      ) : null}
      <div className="wikilinks-editor-scroll">
        <article className="wikilinks-preview wikilinks-editable-document">
          {frontmatterRows.length > 0 ? (
            <dl className="wikilinks-frontmatter">
              {frontmatterRows.map((row, index) => (
                <div className="wikilinks-frontmatter-row" key={`${row.key}-${index}`}>
                  <dt>{row.key}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div
            className="wikilinks-rendered-markdown"
            hidden={editing}
            onClick={requestEdit}
          >
            <InstantMarkdownPreview
              content={result.content}
              renderMedia={renderPreviewMedia}
              renderNoteLink={renderPreviewNoteLink}
              renderUrlLink={renderWebLink}
            />
          </div>
          {LiveMarkdownEditor ? (
            <div className="wikilinks-editor-layer" hidden={!editing}>
              <LiveMarkdownEditor
                key={editorKey}
                bridgeId={editorBridgeId}
                initialValue={result.content}
                active={editing}
                focusRequest={focusRequest}
                selectionRequest={selectionRequest}
                onReady={() => setReadyEditorKey(editorKey)}
                onFirstRender={() => undefined}
                onMarkdownChange={(markdown, selection) => {
                  markdownRef.current = markdown;
                  selectionRef.current = selection;
                  scheduleSave();
                  scheduleDraftWrite();
                }}
                onReferenceOpen={(reference) => openReference(reference)}
                onReferenceHover={showHover}
                onReferenceLeave={hideHover}
              />
            </div>
          ) : null}
        </article>
        {documentBacklinksEnabled ? (
          <DocumentBacklinks
            path={path}
            source={openerSource}
            refreshToken={backlinksRefresh}
            loadFallback={loadFallbackBacklinks}
            renderSourceLink={renderBacklinkSourceLink}
            onOpenThread={(threadId) => navigate.toThread(threadId)}
          />
        ) : null}
      </div>
      <ThinkingTrailParent localId={editorVisitLocalId}>
        <HoverPreviewCard
          anchor={hover?.anchor ?? null}
          title={hover ? displayWikilinkLabel(hover.reference, undefined) : "Note"}
          preview={hover?.preview ?? null}
          loading={hover?.loading ?? false}
          focus={hover ? parseWikilinkSubpath(hover.reference) : null}
          onOpen={hover ? () => openReference(hover.reference) : undefined}
          onInteract={() => {
            if (editorVisitRef.current) trail?.interact(editorVisitRef.current);
          }}
          onPointerEnter={clearHoverClose}
          onPointerLeave={hideHover}
          renderNoteLink={renderNestedNoteLink}
          renderBacklinkLink={(backlink, backlinkChildren) => (
            <PreviewingFileLink
              reference={backlink.sourceTitle}
              target={backlink.target}
              exists
              relation="backlink"
            >
              {backlinkChildren}
            </PreviewingFileLink>
          )}
          renderBacklinkNoteLink={renderBacklinkNoteLink}
          renderUrlLink={renderWebLink}
        />
      </ThinkingTrailParent>
    </div>
  );
}

function findThreadWindow(marker: HTMLElement): HTMLElement | null {
  const containingWindow = marker.closest<HTMLElement>("[data-thread-window]");
  if (containingWindow) return containingWindow;
  let ancestor = marker.parentElement;
  while (ancestor && ancestor !== document.body) {
    const threadWindows = ancestor.querySelectorAll<HTMLElement>(
      "[data-thread-window]",
    );
    if (threadWindows.length === 1) return threadWindows[0]!;
    ancestor = ancestor.parentElement;
  }
  return null;
}

interface ChatHoverState {
  reference: string;
  anchor: HoverAnchorRect;
  preview: HoverPreviewData | null;
  loading: boolean;
  target: ExperimentalLiveFileTarget | null;
}

interface ChatWebHoverState {
  url: string;
  anchor: HoverAnchorRect;
  preview: WebPreviewResult | null;
  loading: boolean;
}

function ChatWikilinkBridge({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const trail = useThinkingTrail();
  const trailParent = useThinkingTrailParent();
  const markerRef = useRef<HTMLSpanElement>(null);
  const bridgeId = useId();
  const [hover, setHover] = useState<ChatHoverState | null>(null);
  const [webHover, setWebHover] = useState<ChatWebHoverState | null>(null);
  const previewCache = useRef(
    new Map<
      string,
      {
        target: ExperimentalLiveFileTarget | null;
        exists: boolean;
        content: string | null;
        imageDataUrl: string | null;
        backlinks: HoverPreviewData["backlinks"];
        truncated: boolean;
        links: HoverPreviewData["links"];
      }
    >(),
  );
  const webPreviewCache = useRef(new Map<string, WebPreviewResult>());
  const showTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const chatVisitRef = useRef<string | null>(null);
  const chatVisitReferenceRef = useRef<string | null>(null);
  const [chatVisitLocalId, setChatVisitLocalId] = useState<string | null>(null);
  const chatPreviewKey = (reference: string, backlinks: boolean) =>
    `${backlinks ? "backlinks" : "note"}\0${reference}`;

  const clearShowTimer = useCallback(() => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    showTimer.current = null;
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const endChatVisit = useCallback(() => {
    if (chatVisitRef.current) trail?.endVisit(chatVisitRef.current);
    chatVisitRef.current = null;
    chatVisitReferenceRef.current = null;
    setChatVisitLocalId(null);
  }, [trail]);
  const beginChatVisit = useCallback(
    (
      reference: string,
      target: ExperimentalLiveFileTarget | null,
      showBacklinks: boolean,
    ) => {
      endChatVisit();
      if (!target) return null;
      const localId =
        trail?.beginVisit({
          label: displayWikilinkLabel(reference, undefined),
          target,
          relation: "link",
          previewMode: showBacklinks ? "backlinks" : "note",
          parentLocalId: trailParent,
        }) ?? null;
      chatVisitRef.current = localId;
      chatVisitReferenceRef.current = reference;
      setChatVisitLocalId(localId);
      if (localId) trail?.markLoaded(localId);
      return localId;
    },
    [endChatVisit, trail, trailParent],
  );
  const markChatClick = useCallback(
    (reference: string, target: ExperimentalLiveFileTarget) => {
      let localId =
        chatVisitReferenceRef.current === reference
          ? chatVisitRef.current
          : null;
      if (!localId) localId = beginChatVisit(reference, target, false);
      if (localId) {
        trail?.interact(localId, true);
        trail?.finish("context-changed");
      }
    },
    [beginChatVisit, trail],
  );
  const hideHover = useCallback(() => {
    clearShowTimer();
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      endChatVisit();
      setHover(null);
      setWebHover(null);
      closeTimer.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearShowTimer, endChatVisit]);
  const openTarget = useCallback(
    (target: ExperimentalLiveFileTarget) => {
      if (!navigate.experimental_openFilePreview({ target, location: null })) {
        toast.error("The file preview is not available in this view.");
      }
    },
    [navigate],
  );

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const threadWindow = findThreadWindow(marker);
    if (threadWindow) threadWindow.dataset.wikilinksBridgeId = bridgeId;
    void rpc
      .call("autocomplete_wikilinks", { threadId, query: "" })
      .catch(() => undefined);

    const onOpen = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ChatWikilinkOpenDetail> | null;
      if (
        detail?.bridgeId !== bridgeId ||
        typeof detail.reference !== "string" ||
        detail.reference.trim() === ""
      ) {
        return;
      }
      const cachedTarget =
        previewCache.current.get(chatPreviewKey(detail.reference, false))
          ?.target ??
        previewCache.current.get(chatPreviewKey(detail.reference, true))
          ?.target;
      if (cachedTarget) {
        markChatClick(detail.reference, cachedTarget);
        openTarget(cachedTarget);
        return;
      }
      void rpc
        .call("resolve_chat_wikilink", {
          threadId,
          reference: detail.reference,
        })
        .then(({ target }) => {
          if (!target) {
            toast.error("This thread has no workspace for that note link.");
            return;
          }
          markChatClick(detail.reference!, target);
          openTarget(target);
        })
        .catch(() => {
          toast.error("Could not resolve that note link.");
        });
    };
    const onHover = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ChatWikilinkHoverDetail> | null;
      const anchor = detail?.anchor;
      if (
        detail?.bridgeId !== bridgeId ||
        typeof detail.reference !== "string" ||
        detail.reference.trim() === "" ||
        !anchor ||
        ![anchor.top, anchor.right, anchor.bottom, anchor.left].every(
          Number.isFinite,
        )
      ) {
        return;
      }
      clearShowTimer();
      clearCloseTimer();
      const reference = detail.reference;
      if (detail.web) {
        endChatVisit();
        setHover(null);
        const revealWeb = () => {
          showTimer.current = null;
          const cached = webPreviewCache.current.get(reference);
          if (cached) {
            setWebHover({
              url: reference,
              anchor,
              preview: cached,
              loading: false,
            });
            return;
          }
          setWebHover({
            url: reference,
            anchor,
            preview: null,
            loading: true,
          });
          const sequence = ++requestSequence.current;
          void rpc.call("preview_url", { url: reference }).then(
            (result) => {
              webPreviewCache.current.set(reference, result);
              if (requestSequence.current !== sequence) return;
              setWebHover({
                url: reference,
                anchor,
                preview: result,
                loading: false,
              });
            },
            () => {
              if (requestSequence.current !== sequence) return;
              setWebHover({
                url: reference,
                anchor,
                preview: null,
                loading: false,
              });
            },
          );
        };
        showTimer.current = window.setTimeout(
          revealWeb,
          detail.immediate ? 0 : HOVER_OPEN_DELAY_MS,
        );
        return;
      }
      setWebHover(null);
      const showBacklinks = detail.backlinks === true;
      const reveal = () => {
        showTimer.current = null;
        const cacheKey = chatPreviewKey(reference, showBacklinks);
        const cached = previewCache.current.get(cacheKey);
        if (cached) {
          beginChatVisit(reference, cached.target, showBacklinks);
          setHover({
            reference,
            anchor,
            preview: {
              content: cached.content,
              imageDataUrl: cached.imageDataUrl,
              backlinks: cached.backlinks,
              truncated: cached.truncated,
              links: cached.links,
            },
            loading: false,
            target: cached.target,
          });
          return;
        }
        setHover({
          reference,
          anchor,
          preview: null,
          loading: true,
          target: null,
        });
        const sequence = ++requestSequence.current;
        void rpc
          .call("preview_chat_wikilink", {
            threadId,
            reference,
            backlinks: showBacklinks,
          })
          .then(
            (result) => {
              previewCache.current.set(cacheKey, result);
              if (requestSequence.current !== sequence) return;
              beginChatVisit(reference, result.target, showBacklinks);
              setHover({
                reference,
                anchor,
                preview: {
                  content: result.content,
                  imageDataUrl: result.imageDataUrl,
                  backlinks: result.backlinks,
                  truncated: result.truncated,
                  links: result.links,
                },
                loading: false,
                target: result.target,
              });
            },
            () => {
              if (requestSequence.current !== sequence) return;
              endChatVisit();
              setHover({
                reference,
                anchor,
                preview: {
                  content: null,
                  imageDataUrl: null,
                  backlinks: showBacklinks ? [] : null,
                  truncated: false,
                  links: [],
                },
                loading: false,
                target: null,
              });
            },
          );
      };
      showTimer.current = window.setTimeout(
        reveal,
        detail.immediate ? 0 : HOVER_OPEN_DELAY_MS,
      );
    };
    const onLeave = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ChatWikilinkOpenDetail> | null;
      if (detail?.bridgeId === bridgeId) hideHover();
    };
    const onAutocompleteQuery = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<ComposerWikilinkQueryDetail> | null;
      if (
        detail?.bridgeId !== bridgeId ||
        typeof detail.requestId !== "number" ||
        typeof detail.query !== "string"
      ) {
        return;
      }
      const requestId = detail.requestId;
      void rpc
        .call("autocomplete_wikilinks", { threadId, query: detail.query })
        .then(
          (suggestions) => {
            window.dispatchEvent(
              new CustomEvent<ComposerWikilinkResultsDetail>(
                COMPOSER_WIKILINK_RESULTS_EVENT,
                { detail: { bridgeId, requestId, suggestions } },
              ),
            );
          },
          () => {
            window.dispatchEvent(
              new CustomEvent<ComposerWikilinkResultsDetail>(
                COMPOSER_WIKILINK_RESULTS_EVENT,
                { detail: { bridgeId, requestId, suggestions: [] } },
              ),
            );
          },
        );
    };
    window.addEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    window.addEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
    window.addEventListener(CHAT_WIKILINK_LEAVE_EVENT, onLeave);
    window.addEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onAutocompleteQuery);
    return () => {
      window.removeEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
      window.removeEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
      window.removeEventListener(CHAT_WIKILINK_LEAVE_EVENT, onLeave);
      window.removeEventListener(
        COMPOSER_WIKILINK_QUERY_EVENT,
        onAutocompleteQuery,
      );
      clearShowTimer();
      clearCloseTimer();
      endChatVisit();
      requestSequence.current += 1;
      if (threadWindow?.dataset.wikilinksBridgeId === bridgeId) {
        delete threadWindow.dataset.wikilinksBridgeId;
      }
    };
  }, [
    bridgeId,
    clearCloseTimer,
    clearShowTimer,
    beginChatVisit,
    endChatVisit,
    hideHover,
    markChatClick,
    openTarget,
    rpc,
    threadId,
  ]);

  const hoverLinkIndex = useMemo(
    () =>
      new Map(
        (hover?.preview?.links ?? []).map((link) => [link.reference, link]),
      ),
    [hover?.preview],
  );
  const renderNestedNoteLink = useCallback(
    (reference: string, children: ReactNode) => {
      const link = hoverLinkIndex.get(reference);
      if (!link) {
        return (
          <span className="wikilink wikilink-unresolved">{children}</span>
        );
      }
      return (
        <PreviewingFileLink
          reference={reference}
          target={link.target}
          exists={link.exists}
        >
          {children}
        </PreviewingFileLink>
      );
    },
    [hoverLinkIndex],
  );

  return (
    <>
      <span
        ref={markerRef}
        data-wikilinks-bridge-marker={bridgeId}
        aria-hidden="true"
        style={{ display: "none" }}
      />
      <ThinkingTrailParent localId={chatVisitLocalId}>
        <HoverPreviewCard
          anchor={hover?.anchor ?? null}
          title={
            hover ? displayWikilinkLabel(hover.reference, undefined) : "Note"
          }
          preview={hover?.preview ?? null}
          loading={hover?.loading ?? false}
          focus={hover ? parseWikilinkSubpath(hover.reference) : null}
          onOpen={
            hover?.target
              ? () => {
                  markChatClick(hover.reference, hover.target!);
                  openTarget(hover.target!);
                }
              : undefined
          }
          onInteract={() => {
            if (chatVisitRef.current) trail?.interact(chatVisitRef.current);
          }}
          onPointerEnter={clearCloseTimer}
          onPointerLeave={hideHover}
          renderNoteLink={renderNestedNoteLink}
          renderBacklinkLink={(backlink, backlinkChildren) => (
            <PreviewingFileLink
              reference={backlink.sourceTitle}
              target={backlink.target}
              exists
              relation="backlink"
            >
              {backlinkChildren}
            </PreviewingFileLink>
          )}
          renderBacklinkNoteLink={renderBacklinkNoteLink}
          renderUrlLink={renderWebLink}
        />
      </ThinkingTrailParent>
      <HoverPreviewCard
        anchor={webHover?.anchor ?? null}
        title={webHover?.preview?.title ?? webTitle(webHover?.url ?? "")}
        preview={webHoverData(webHover?.preview ?? null)}
        loading={webHover?.loading ?? false}
        onOpen={
          webHover
            ? () => navigate.openUrl(webHover.preview?.url ?? webHover.url)
            : undefined
        }
        onPointerEnter={clearCloseTimer}
        onPointerLeave={hideHover}
        renderUrlLink={(href, children) => {
          const resolved = webHover
            ? absoluteWebUrl(href, webHover.preview?.url ?? webHover.url)
            : null;
          return resolved ? (
            <PreviewingUrlLink url={resolved}>{children}</PreviewingUrlLink>
          ) : (
            <span className="wikilink-standard">{children}</span>
          );
        }}
        contentKind="web"
        openLabel="Open page"
        footerLabel={`Excerpt from ${
          webHover?.preview?.siteName ?? webTitle(webHover?.url ?? "")
        }`}
      />
    </>
  );
}

function TrackedChatWikilinkBridge({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const record = useCallback(
    (trail: CapturedThinkingTrail) => {
      void rpc.call("record_thinking_trail", { trail }).catch(() => undefined);
    },
    [rpc],
  );
  return (
    <ThinkingTrailProvider
      threadId={threadId}
      projectId={null}
      originKind="chat"
      rootLabel="Chat thread"
      rootTarget={null}
      record={record}
    >
      <ChatWikilinkBridge threadId={threadId} />
    </ThinkingTrailProvider>
  );
}

function TrailStepTree({
  trail,
  parentOrdinal,
}: {
  trail: StoredThinkingTrail;
  parentOrdinal: number | null;
}) {
  const children = trail.steps.filter(
    (step) => step.parentOrdinal === parentOrdinal,
  );
  if (children.length === 0) return null;
  return (
    <ul className="thinking-trail-tree">
      {children.map((step: StoredThinkingTrailStep) => (
        <li key={step.ordinal}>
          <div className="thinking-trail-step">
            {step.target ? (
              <FileLink target={step.target} className="thinking-trail-link">
                {step.label}
              </FileLink>
            ) : (
              <span>{step.label}</span>
            )}
            <span className="thinking-trail-step-meta">
              {step.clicked ? "Clicked · " : ""}
              {(step.dwellMs / 1_000).toFixed(1)}s
              {step.previewMode === "backlinks" ? " · Backlinks" : ""}
            </span>
          </div>
          <TrailStepTree trail={trail} parentOrdinal={step.ordinal} />
        </li>
      ))}
    </ul>
  );
}

function ThinkingTrailsPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [trails, setTrails] = useState<StoredThinkingTrail[]>([]);
  const [onlyThisThread, setOnlyThisThread] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const load = async () => {
      try {
        const result = await rpc.call("list_thinking_trails", {
          threadId: onlyThisThread ? threadId : null,
          limit: 30,
        });
        if (active) setTrails(result.trails);
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(load, 3_000);
        }
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [onlyThisThread, rpc, threadId]);

  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [],
  );

  return (
    <div className="thinking-trails-panel">
      <div className="thinking-trails-intro">
        <div>
          <h2>Thinking trails</h2>
          <p>Paths you deliberately explored through hover previews.</p>
        </div>
        <div className="thinking-trails-filter" role="group" aria-label="Trail scope">
          <button
            type="button"
            data-active={!onlyThisThread}
            onClick={() => setOnlyThisThread(false)}
          >
            All
          </button>
          <button
            type="button"
            data-active={onlyThisThread}
            onClick={() => setOnlyThisThread(true)}
          >
            This thread
          </button>
        </div>
      </div>
      {loading ? (
        <p className="thinking-trails-empty">Loading trails…</p>
      ) : trails.length === 0 ? (
        <p className="thinking-trails-empty">
          No completed trails yet. Follow a hover-preview path, then leave the
          chain for two seconds.
        </p>
      ) : (
        <div className="thinking-trails-list">
          {trails.map((trail) => (
            <article className="thinking-trail-card" key={trail.id}>
              <div className="thinking-trail-card-header">
                <time dateTime={new Date(trail.startedAtMs).toISOString()}>
                  {formatter.format(trail.startedAtMs)}
                </time>
                <span>
                  {Math.max(1, Math.round(trail.durationMs / 1_000))}s · {trail.signalScore}/100
                </span>
              </div>
              <TrailStepTree trail={trail} parentOrdinal={null} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "obsidian-wikilinks",
    title: "Obsidian at Home",
    extensions: ["md", "markdown"],
    component: TrackedWikilinkFileOpener,
  });
  app.slots.experimental_threadHeaderAction({
    id: "chat-wikilinks-navigation",
    title: "Chat wikilinks navigation",
    component: TrackedChatWikilinkBridge,
  });
  app.slots.threadPanelAction({
    id: "thinking-trails",
    title: "Thinking trails",
    icon: "Route",
    component: ThinkingTrailsPanel,
    layout: "padded",
  });
  app.contentScripts.register({
    id: "chat-wikilinks",
    mount: ({ signal }) => mountChatWikilinks(signal),
  });
  app.contentScripts.register({
    id: "composer-wikilink-autocomplete",
    mount: ({ signal }) => mountComposerWikilinkAutocomplete(signal),
  });
});
