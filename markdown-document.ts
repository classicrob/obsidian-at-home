export interface ParsedMarkdownDocument {
  frontmatter: string;
  frontmatterRows: Array<{ key: string; value: string }>;
  body: string;
  bodyLeadingBreaks: string;
}

export function parseMarkdownDocument(
  content: string,
): ParsedMarkdownDocument {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    content,
  );
  if (!match) {
    return {
      frontmatter: "",
      frontmatterRows: [],
      body: content,
      bodyLeadingBreaks: "",
    };
  }
  const body = content.slice(match[0].length);
  return {
    frontmatter: match[0],
    frontmatterRows: match[1]!.split(/\r?\n/).map((line) => {
      const separator = line.indexOf(":");
      return separator === -1
        ? { key: "", value: line }
        : {
            key: line.slice(0, separator).trim(),
            value: line.slice(separator + 1).trim(),
          };
    }),
    body,
    bodyLeadingBreaks: /^(?:\r?\n)*/.exec(body)?.[0] ?? "",
  };
}

export function restoreWikilinkEscapes(markdown: string): string {
  return markdown.replaceAll("\\[\\[", "[[").replaceAll("\\]\\]", "]]");
}
