import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  UrlLink,
  type ExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/app";
import {
  decodeLocalMarkdownPath,
  decodeWikilinkUrl,
  remarkWikilinks,
  WIKILINK_URL_PREFIX,
} from "./wikilink-markdown.js";
import type { HoverAnchorRect } from "./hover-types.js";

export interface HoverPreviewLink {
  reference: string;
  target: ExperimentalLiveFileTarget;
  exists: boolean;
}

export interface HoverPreviewBacklink {
  sourceTitle: string;
  headings: string[];
  context: string;
  target: ExperimentalLiveFileTarget;
  links: HoverPreviewLink[];
}

export interface HoverPreviewData {
  content: string | null;
  imageDataUrl: string | null;
  backlinks: HoverPreviewBacklink[] | null;
  truncated: boolean;
  links: HoverPreviewLink[];
}

export const HOVER_OPEN_DELAY_MS = 350;
export const HOVER_CLOSE_DELAY_MS = 180;

function createHoverMarkdownComponents(
  renderNoteLink?: (reference: string, children: ReactNode) => ReactNode,
  renderUrlLink?: (url: string, children: ReactNode) => ReactNode,
  contentKind: "note" | "web" = "note",
): Components {
  return {
    h1: ({ node: _node, ...props }) => (
      <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0" {...props} />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0" {...props} />
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 className="mb-1.5 mt-3 font-semibold first:mt-0" {...props} />
    ),
    p: ({ node: _node, ...props }) => (
      <p className="my-2 first:mt-0" {...props} />
    ),
    ul: ({ node: _node, ...props }) => (
      <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
    ),
    ol: ({ node: _node, ...props }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
    ),
    blockquote: ({ node: _node, ...props }) => (
      <blockquote
        className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
        {...props}
      />
    ),
    a: ({ node: _node, href = "", children, ...props }) => {
      if (contentKind === "web" && renderUrlLink) {
        return <>{renderUrlLink(href, children)}</>;
      }
      const reference =
        decodeWikilinkUrl(href) ?? decodeLocalMarkdownPath(href);
      if (reference !== null) {
        if (renderNoteLink) return <>{renderNoteLink(reference, children)}</>;
        return <span className="wikilink">{children}</span>;
      }
      if (/^https?:\/\//i.test(href)) {
        if (renderUrlLink) return <>{renderUrlLink(href, children)}</>;
        return (
          <UrlLink href={href} className="wikilink-standard" {...props}>
            {children}
          </UrlLink>
        );
      }
      return (
        <a href={href} className="wikilink-standard" {...props}>
          {children}
        </a>
      );
    },
    code: ({ node: _node, ...props }) => (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]"
        {...props}
      />
    ),
    pre: ({ node: _node, ...props }) => (
      <pre
        className="my-3 overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs [&_code]:bg-transparent [&_code]:p-0"
        {...props}
      />
    ),
    img: ({ node: _node, alt }) =>
      alt ? <span className="text-muted-foreground">[Image: {alt}]</span> : null,
  };
}

export function HoverPreviewCard({
  anchor,
  title,
  preview,
  loading,
  onOpen,
  onInteract,
  onPointerEnter,
  onPointerLeave,
  renderNoteLink,
  renderBacklinkLink,
  renderBacklinkNoteLink,
  renderUrlLink,
  contentKind = "note",
  openLabel = "Open file",
  footerLabel = "Excerpt from the note",
  portalContainer,
}: {
  anchor: HoverAnchorRect | null;
  title: string;
  preview: HoverPreviewData | null;
  loading: boolean;
  onOpen?: () => void;
  onInteract?: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  renderNoteLink?: (reference: string, children: ReactNode) => ReactNode;
  renderBacklinkLink?: (
    backlink: NonNullable<HoverPreviewData["backlinks"]>[number],
    children: ReactNode,
  ) => ReactNode;
  renderBacklinkNoteLink?: (
    backlink: HoverPreviewBacklink,
    reference: string,
    children: ReactNode,
  ) => ReactNode;
  renderUrlLink?: (url: string, children: ReactNode) => ReactNode;
  contentKind?: "note" | "web";
  openLabel?: string;
  footerLabel?: string;
  portalContainer?: Element | null;
}) {
  const components = useMemo(
    () =>
      createHoverMarkdownComponents(
        renderNoteLink,
        renderUrlLink,
        contentKind,
      ),
    [contentKind, renderNoteLink, renderUrlLink],
  );
  if (!anchor) return null;
  const cardWidth = Math.min(440, Math.max(280, window.innerWidth - 24));
  const left = Math.max(
    12,
    Math.min(anchor.left, window.innerWidth - cardWidth - 12),
  );
  const showAbove = window.innerHeight - anchor.bottom < 330 && anchor.top > 260;
  const availableHeight = showAbove
    ? anchor.top - 20
    : window.innerHeight - anchor.bottom - 20;
  const position = showAbove
    ? {
        bottom: window.innerHeight - anchor.top + 8,
        left,
        width: cardWidth,
        maxHeight: Math.max(120, Math.min(380, availableHeight)),
      }
    : {
        top: anchor.bottom + 8,
        left,
        width: cardWidth,
        maxHeight: Math.max(120, Math.min(380, availableHeight)),
      };

  return createPortal(
    <aside
      data-wikilink-hover-preview=""
      role="dialog"
      aria-label={`Preview of ${title}`}
      className="wikilink-hover-card"
      style={position}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onPointerEnter}
      onBlurCapture={onPointerLeave}
    >
      <div className="wikilink-hover-card-header">
        <span className="wikilink-hover-title">{title}</span>
        {onOpen ? (
          <button type="button" className="wikilink-hover-open" onClick={onOpen}>
            {openLabel}
          </button>
        ) : null}
      </div>
      <div
        className="wikilink-hover-card-body"
        onScroll={onInteract}
        onPointerDown={onInteract}
      >
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading preview…</p>
        ) : preview?.backlinks !== null && preview?.backlinks !== undefined ? (
          <div className="wikilink-backlinks">
            <div className="wikilink-backlinks-heading">
              Contextual backlinks
            </div>
            {preview.backlinks.length > 0 ? (
              preview.backlinks.map((backlink, index) => (
                <section
                  className="wikilink-backlink"
                  key={`${backlink.sourceTitle}-${backlink.headings.join("/")}-${index}`}
                >
                  <div className="wikilink-backlink-source">
                    {renderBacklinkLink
                      ? renderBacklinkLink(backlink, backlink.sourceTitle)
                      : backlink.sourceTitle}
                  </div>
                  {backlink.headings.length > 0 ? (
                    <div className="wikilink-backlink-breadcrumbs">
                      {backlink.headings.join(" › ")}
                    </div>
                  ) : null}
                  <div className="wikilink-backlink-context">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkWikilinks]}
                      components={createHoverMarkdownComponents(
                        renderBacklinkNoteLink
                          ? (reference, children) =>
                              renderBacklinkNoteLink(
                                backlink,
                                reference,
                                children,
                              )
                          : renderNoteLink,
                        renderUrlLink,
                      )}
                      urlTransform={(url) =>
                        url.startsWith(WIKILINK_URL_PREFIX) ||
                        decodeLocalMarkdownPath(url)
                          ? url
                          : defaultUrlTransform(url)
                      }
                    >
                      {backlink.context}
                    </ReactMarkdown>
                  </div>
                </section>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No contextual backlinks found.
              </p>
            )}
          </div>
        ) : preview?.imageDataUrl ? (
          <img
            className="wikilink-tldraw-preview"
            src={preview.imageDataUrl}
            alt={`Canvas preview of ${title}`}
          />
        ) : preview?.content ? (
          <ReactMarkdown
            remarkPlugins={
              contentKind === "web" ? [remarkGfm] : [remarkGfm, remarkWikilinks]
            }
            components={components}
            urlTransform={(url) =>
              url.startsWith(WIKILINK_URL_PREFIX) || decodeLocalMarkdownPath(url)
                ? url
                : defaultUrlTransform(url)
            }
          >
            {preview.content}
          </ReactMarkdown>
        ) : (
          <p className="text-sm text-muted-foreground">Preview unavailable.</p>
        )}
      </div>
      {preview?.truncated ? (
        <div className="wikilink-hover-card-footer">{footerLabel}</div>
      ) : null}
    </aside>,
    portalContainer ?? document.body,
  );
}
