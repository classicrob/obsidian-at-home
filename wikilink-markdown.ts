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
  children?: MarkdownNode[];
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

export function splitWikilinkText(value: string): MarkdownNode[] | null {
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index;
    if (start > 0 && value[start - 1] === "!") continue;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    const [rawReference, rawAlias] = match[1]!.split("|", 2);
    const reference = rawReference!.trim();
    if (reference === "") {
      nodes.push({ type: "text", value: match[0] });
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

function transformChildren(node: MarkdownNode): void {
  if (!node.children) return;
  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      nextChildren.push(...(splitWikilinkText(child.value) ?? [child]));
    } else {
      transformChildren(child);
      nextChildren.push(child);
    }
  }
  node.children = nextChildren;
}

export function remarkWikilinks() {
  return (tree: MarkdownNode) => {
    transformChildren(tree);
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
