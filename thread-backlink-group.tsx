import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HoverPreviewCard, HOVER_CLOSE_DELAY_MS, HOVER_OPEN_DELAY_MS, type HoverPreviewLink } from "./hover-preview.js";
import { elementRect, type HoverAnchorRect } from "./hover-types.js";
import { decodeWikilinkUrl, remarkWikilinks, WIKILINK_URL_PREFIX } from "./wikilink-markdown.js";
import type { DocumentBacklinkGroup } from "./document-backlinks-model.js";
import type { ThreadBacklinkOccurrence } from "./thread-backlinks.js";

export interface ThreadBacklinkData {
  occurrences: ThreadBacklinkOccurrence[];
  truncated: boolean;
  links: HoverPreviewLink[];
}
export type LoadThreadContext = (threadId: string) => Promise<ThreadBacklinkData>;
export type RenderThreadNoteLink = (link: HoverPreviewLink, children: ReactNode) => ReactNode;

// Keep opening a long note's backlinks from fetching every conversation at once.
let activeLoads = 0;
const waiting: (() => void)[] = [];
async function loadInQueue(load: () => Promise<ThreadBacklinkData>, cancelled: () => boolean) {
  if (activeLoads >= 3) await new Promise<void>(resolve => waiting.push(resolve));
  else activeLoads++;
  try { return cancelled() ? null : await load(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else activeLoads--;
  }
}

export function ThreadBacklinkGroup({ group, loadContext, renderNoteLink, onOpen }: {
  group: DocumentBacklinkGroup;
  loadContext?: LoadThreadContext;
  renderNoteLink?: RenderThreadNoteLink;
  onOpen(threadId: string): void;
}) {
  const [data, setData] = useState<ThreadBacklinkData | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [hover, setHover] = useState<{ anchor: HoverAnchorRect; occurrence: ThreadBacklinkOccurrence } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    setHover(null);
    if (loadContext && group.threadId) {
      void loadInQueue(() => loadContext(group.threadId!), () => cancelled).then(
        result => { if (!cancelled && result) setData(result); },
        () => { if (!cancelled) setError(true); },
      );
    }
    return () => { cancelled = true; clearTimers(); };
  }, [group, loadContext, retry]);
  useEffect(() => {
    if (!hover) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { clearTimers(); setHover(null); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [hover]);
  const show = (element: HTMLElement, occurrence = data?.occurrences[0]) => {
    clearTimers();
    if (!occurrence) return;
    const anchor = elementRect(element);
    openTimer.current = setTimeout(() => setHover({ anchor, occurrence }), HOVER_OPEN_DELAY_MS);
  };
  const leave = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setHover(null), HOVER_CLOSE_DELAY_MS);
  };
  const keep = () => { clearTimers(); };
  const open = () => { clearTimers(); setHover(null); onOpen(group.threadId!); };
  const noteLink = (reference: string, children: ReactNode) => {
    const link = data?.links.find(item => item.reference === reference);
    return link && renderNoteLink ? renderNoteLink(link, children) : <span className="wikilink">{children}</span>;
  };
  return <li className="wikilinks-document-backlink-group">
    <div className="wikilinks-document-backlink-source">
      <button type="button" className="wikilinks-document-backlink-thread" onClick={open} onPointerEnter={event => show(event.currentTarget)} onPointerLeave={leave} onFocus={event => show(event.currentTarget)} onBlur={leave}>{group.title}</button>
      <span className="wikilinks-document-backlink-kind">thread{data && data.occurrences.length > 1 ? ` · ${data.occurrences.length}${data.truncated ? "+" : ""}` : ""}</span>
    </div>
    {data?.occurrences.length ? <ul className="wikilinks-document-backlink-occurrences">
      {data.occurrences.map(occurrence => <li className="wikilinks-document-backlink-occurrence wikilinks-thread-context" key={occurrence.messageId}>
        {occurrence.userPrompt ? <div className="wikilink-backlink-breadcrumbs wikilinks-thread-prompt" title={occurrence.userPrompt} aria-label="Preceding user message">You: {occurrence.userPrompt}</div> : null}
        <div className="wikilinks-thread-message-meta">{occurrence.role === "user" ? "You" : "Assistant"}{occurrence.createdAt > 0 ? <> · <time dateTime={new Date(occurrence.createdAt).toISOString()}>{new Date(occurrence.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></> : null}</div>
        <div className="wikilinks-thread-context-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkWikilinks]} urlTransform={url => url.startsWith(WIKILINK_URL_PREFIX) ? url : /^https?:\/\//i.test(url) ? url : ""} components={{
            a: ({ href = "", children }) => { const ref = decodeWikilinkUrl(href); return ref === null ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : noteLink(ref, children); },
            img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : ""}</span>,
          }}>{occurrence.context}</ReactMarkdown>
        </div>
      </li>)}
    </ul> : loadContext ? <p className="wikilinks-thread-context-status">{error ? <>Couldn’t load mentioning messages. <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></> : data ? (data.truncated ? "Mention is outside the loaded conversation excerpt." : "Mention is no longer present in this conversation.") : "Loading mentioning messages…"}</p> : null}
    <HoverPreviewCard anchor={hover?.anchor ?? null} title={group.title} preview={hover ? { content: hover.occurrence.preview, backlinks: null, imageDataUrl: null, truncated: data?.truncated ?? false, links: data?.links ?? [] } : null} loading={false} focus={hover ? { kind: "heading", text: hover.occurrence.focusLabel } : null} onOpen={open} openLabel="Open thread" footerLabel="Conversation around this note’s mention" onPointerEnter={keep} onPointerLeave={leave} renderNoteLink={noteLink} />
  </li>;
}
