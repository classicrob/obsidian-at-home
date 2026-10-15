import { containsIframe } from "./iframe-embed.js";

export const WIKILINK_URL_PREFIX = "bb-wikilink:";

function stripAngleBrackets(value: string): string {
  return value.startsWith("<") && value.endsWith(">")
    ? value.slice(1, -1)
    : value;
}

export function decodeLocalMarkdownPath(url: string): string | null {
  let value = stripAngleBrackets(url.trim());
  if (value === "") return null;

  if (/^file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname !== "" && parsed.hostname !== "localhost") return null;
      value = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    const isWindowsPath = /^[a-z]:[\\/]/i.test(value);
    if (!isWindowsPath && /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    if (value.startsWith("//")) return null;
    value = value.split(/[?#]/, 1)[0]!;
  }

  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  return /\.(?:md|markdown|tldraw)$/i.test(value) ? value : null;
}

export function extractLocalMarkdownPaths(markdown: string): string[] {
  const paths = new Set<string>();
  const pattern =
    /(!?)\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\.|[^()\s\n]|\([^()\n]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) {
    if (match[1] === "!") continue;
    const localPath = decodeLocalMarkdownPath(match[2]!);
    if (localPath) paths.add(localPath);
  }
  return [...paths];
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  depth?: number;
  alt?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown>; [key: string]: unknown };
}

/** The `#heading` or `#^block` part of a wikilink reference, if any. */
export type WikilinkSubpath =
  | { kind: "block"; id: string }
  | { kind: "heading"; text: string };

export function normalizeHeadingText(value: string): string {
  return value
    .replace(/[*_`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function parseWikilinkSubpath(reference: string): WikilinkSubpath | null {
  const withoutAlias = reference.split("|", 1)[0]!;
  const hashIndex = withoutAlias.indexOf("#");
  if (hashIndex === -1) return null;
  // Obsidian allows nested headings (`Note#A#B`); the last part is the target.
  const subpath = withoutAlias.slice(hashIndex + 1).split("#").at(-1)!.trim();
  if (subpath === "") return null;
  if (subpath.startsWith("^")) {
    const id = subpath.slice(1).trim();
    return id === "" ? null : { kind: "block", id };
  }
  return { kind: "heading", text: normalizeHeadingText(subpath) };
}

const BLOCK_ID_SUFFIX = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;

function setHProperty(node: MarkdownNode, key: string, value: string): void {
  const data = node.data ?? (node.data = {});
  const properties = data.hProperties ?? (data.hProperties = {});
  properties[key] = value;
}

function plainText(node: MarkdownNode): string {
  if (typeof node.value === "string" && node.type !== "html") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

/**
 * Obsidian block anchors (`… ^abc123` at the end of a block) become a
 * `data-block-id` on the rendered element and the marker text is hidden, so
 * a hover preview can scroll to `[[Note#^abc123]]`. Headings get a
 * `data-heading` with their normalized text for `[[Note#Heading]]`.
 */
function annotateBlockAnchors(node: MarkdownNode, parent: MarkdownNode | null): void {
  if (node.type === "heading") {
    setHProperty(node, "data-heading", normalizeHeadingText(plainText(node)));
  }
  if (node.type === "paragraph" || node.type === "heading" || node.type === "tableCell") {
    const last = node.children?.at(-1);
    if (last && last.type === "text" && typeof last.value === "string") {
      const match = BLOCK_ID_SUFFIX.exec(last.value);
      if (match) {
        last.value = last.value.slice(0, match.index).replace(/\s+$/, "");
        if (last.value === "") node.children!.pop();
        const owner =
          parent && (parent.type === "listItem" || parent.type === "tableRow") ? parent : node;
        setHProperty(owner, "data-block-id", match[1]!);
      }
    }
  }
  for (const child of node.children ?? []) annotateBlockAnchors(child, node);
}

export function remarkBlockAnchors() {
  return (tree: MarkdownNode) => {
    annotateBlockAnchors(tree, null);
  };
}

export function displayWikilinkLabel(
  reference: string,
  alias: string | undefined,
): string {
  const trimmedAlias = alias?.trim();
  if (trimmedAlias) return trimmedAlias;
  const withoutSubpath = reference.split("#", 1)[0]!.trim();
  if (withoutSubpath === "") return reference.trim();
  const basename = withoutSubpath.replace(/\\/g, "/").split("/").at(-1)!;
  return basename.replace(/\.(?:md|markdown|tldraw)$/i, "");
}

export function splitWikilinkText(value: string, includeMedia = false): MarkdownNode[] | null {
  const pattern = /(!?)\[\[([^\]\n]+)\]\]/g;
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    const embed = match[1] === "!";
    if (embed && (!includeMedia || !mediaKind(match[2]!.split("|", 1)[0]!))) continue;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    const [rawReference, rawAlias] = match[2]!.split("|", 2);
    const reference = rawReference!.trim();
    if (reference === "") {
      nodes.push({ type: "text", value: match[0] });
    } else if (embed) {
      nodes.push({ type: "image", url: `${WIKIMEDIA_URL_PREFIX}${encodeURIComponent(reference)}`, alt: rawAlias?.trim() ?? "" });
    } else {
      nodes.push({
        type: "link",
        url: `${WIKILINK_URL_PREFIX}${encodeURIComponent(reference)}`,
        children: [
          {
            type: "text",
            value: displayWikilinkLabel(reference, rawAlias),
          },
        ],
      });
    }
    cursor = start + match[0].length;
  }
  if (cursor === 0) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function transformChildren(node: MarkdownNode, includeMedia: boolean): void {
  if (!node.children) return;
  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...(splitWikilinkText(child.value, includeMedia) ?? [child]));
    } else {
      transformChildren(child, includeMedia);
      nextChildren.push(child);
    }
  }
  node.children = nextChildren;
}

export function remarkWikilinks(options: { media?: boolean } = {}) {
  return (tree: MarkdownNode) => {
    transformChildren(tree, options.media === true);
  };
}

export function decodeWikilinkUrl(url: string): string | null {
  if (!url.startsWith(WIKILINK_URL_PREFIX)) return null;
  try {
    return decodeURIComponent(url.slice(WIKILINK_URL_PREFIX.length));
  } catch {
    return null;
  }
}

export const WIKIMEDIA_URL_PREFIX = "bb-wikimedia:";
export function mediaKind(reference: string): "image" | "video" | "audio" | null {
  const file = reference.split("#", 1)[0]!.trim();
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file)) return "image";
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(file)) return "video";
  if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(file)) return "audio";
  return null;
}
export function decodeWikimediaUrl(url: string): string | null {
  if (!url.startsWith(WIKIMEDIA_URL_PREFIX)) return null;
  try { return decodeURIComponent(url.slice(WIKIMEDIA_URL_PREFIX.length)); } catch { return null; }
}

export const IFRAME_EMBED_TAG = "wikilinks-iframe";

/**
 * Raw HTML that contains an `<iframe>` becomes a `wikilinks-iframe` element
 * carrying the original markup, which the preview renders through the
 * iframe allowlist. Inline `<iframe …>` and its `</iframe>` arrive as two
 * html nodes; the closing one is dropped. Other raw HTML is left untouched.
 */
function transformIframes(node: MarkdownNode): void {
  if (!node.children) return;
  const nextChildren: MarkdownNode[] = [];
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]!;
    if (child.type === "html" && typeof child.value === "string" && containsIframe(child.value)) {
      const inline = node.type !== "root" && node.type !== "blockquote" && node.type !== "listItem";
      let html = child.value;
      const next = node.children[index + 1];
      if (next?.type === "html" && /^<\/iframe\s*>$/i.test(next.value ?? "")) {
        html += next.value;
        index++;
      }
      nextChildren.push({
        type: "iframeEmbed",
        data: { hName: IFRAME_EMBED_TAG, hProperties: { dataHtml: html, dataInline: String(inline) } },
      });
      continue;
    }
    transformIframes(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkIframeEmbeds() {
  return (tree: MarkdownNode) => {
    transformIframes(tree);
  };
}
