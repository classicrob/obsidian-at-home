import { useMemo, type ReactNode } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  decodeLocalMarkdownPath,
  decodeWikilinkUrl,
  remarkWikilinks,
  WIKILINK_URL_PREFIX,
} from "./wikilink-markdown.js";
import { parseMarkdownDocument } from "./markdown-document.js";

function markdownComponents(
  renderNoteLink: (reference: string, children: ReactNode) => ReactNode,
  renderUrlLink: (url: string, children: ReactNode) => ReactNode,
): Components {
  return {
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
}: {
  content: string;
  renderNoteLink: (reference: string, children: ReactNode) => ReactNode;
  renderUrlLink: (url: string, children: ReactNode) => ReactNode;
}) {
  const document = useMemo(() => parseMarkdownDocument(content), [content]);
  const components = useMemo(
    () => markdownComponents(renderNoteLink, renderUrlLink),
    [renderNoteLink, renderUrlLink],
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkWikilinks]}
      components={components}
      urlTransform={(url) =>
        url.startsWith(WIKILINK_URL_PREFIX) || decodeLocalMarkdownPath(url)
          ? url
          : defaultUrlTransform(url)
      }
    >
      {document.body}
    </ReactMarkdown>
  );
}
