import { useMemo, type ReactNode } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  decodeWikimediaUrl,
  WIKIMEDIA_URL_PREFIX,
  decodeLocalMarkdownPath,
  decodeWikilinkUrl,
  remarkWikilinks,
  WIKILINK_URL_PREFIX,
} from "./wikilink-markdown.js";
import { parseMarkdownDocument } from "./markdown-document.js";

function markdownComponents(
  renderNoteLink: (reference: string, children: ReactNode) => ReactNode,
  renderUrlLink: (url: string, children: ReactNode) => ReactNode,
  renderMedia?: (reference: string, alias: string) => ReactNode,
): Components {
  return {
    img: ({ node: _node, src = "", alt = "", ...props }) => {
      const reference = decodeWikimediaUrl(src);
      if (reference !== null) return <>{renderMedia?.(reference, alt) ?? `![[${reference}]]`}</>;
      return <img src={src} alt={alt} {...props} />;
    },
    a: ({ node: _node, href = "", children, ...props }) => {
      const reference =
        decodeWikilinkUrl(href) ?? decodeLocalMarkdownPath(href);
      if (reference !== null) return <>{renderNoteLink(reference, children)}</>;
      if (/^https?:\/\//i.test(href)) {
        return <>{renderUrlLink(href, children)}</>;
      }
      return (
        <a href={href} className="wikilink-standard" {...props}>
          {children}
        </a>
      );
    },
  };
}

export function InstantMarkdownPreview({
  content,
  renderNoteLink,
  renderUrlLink,
  renderMedia,
}: {
  content: string;
  renderMedia?: (reference: string, alias: string) => ReactNode;
  renderNoteLink: (reference: string, children: ReactNode) => ReactNode;
  renderUrlLink: (url: string, children: ReactNode) => ReactNode;
}) {
  const document = useMemo(() => parseMarkdownDocument(content), [content]);
  const components = useMemo(
    () => markdownComponents(renderNoteLink, renderUrlLink, renderMedia),
    [renderNoteLink, renderUrlLink, renderMedia],
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkWikilinks, { media: true }]]}
      components={components}
      urlTransform={(url) =>
        url.startsWith(WIKIMEDIA_URL_PREFIX) || url.startsWith(WIKILINK_URL_PREFIX) || decodeLocalMarkdownPath(url)
          ? url
          : defaultUrlTransform(url)
      }
    >
      {document.body}
    </ReactMarkdown>
  );
}
