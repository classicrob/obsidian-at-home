const YAML_FRONTMATTER = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export interface MarkdownExcerpt {
  content: string;
  truncated: boolean;
}

export function stripYamlFrontmatter(markdown: string): string {
  return markdown.replace(YAML_FRONTMATTER, "");
}

export function createMarkdownExcerpt(
  markdown: string,
  maximumLength = 4_000,
): MarkdownExcerpt {
  const body = stripYamlFrontmatter(markdown).trimStart();
  if (body.length <= maximumLength) {
    return { content: body, truncated: false };
  }

  const paragraphBreak = body.lastIndexOf("\n\n", maximumLength);
  const lineBreak = body.lastIndexOf("\n", maximumLength);
  const preferredBreak =
    paragraphBreak >= maximumLength / 2
      ? paragraphBreak
      : lineBreak >= maximumLength / 2
        ? lineBreak
        : maximumLength;
  return {
    content: `${body.slice(0, preferredBreak).trimEnd()}\n\n…`,
    truncated: true,
  };
}
