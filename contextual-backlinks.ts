import path from "node:path";
import { normalizeWikilinkReference } from "./wikilinks.js";
import { parseMarkdownDocument } from "./markdown-document.js";

export interface ContextualLinkOccurrence {
  targetPath: string;
  headings: string[];
  context: string;
}

function linkableExtension(value: string): string {
  return /\.(?:md|markdown|tldraw)$/i.test(value) ? value : `${value}.md`;
}

function normalizedCandidate(value: string): string {
  return value.replace(/\\/g, "/").toLocaleLowerCase();
}

function compareCandidates(left: string, right: string): number {
  return (
    left.split("/").length - right.split("/").length ||
    left.localeCompare(right)
  );
}

export function createWikilinkPathResolver(paths: readonly string[]) {
  const normalizedPaths = paths.map((candidate) => candidate.replace(/\\/g, "/"));
  const exact = new Map(
    normalizedPaths.map((candidate) => [normalizedCandidate(candidate), candidate]),
  );
  const basenameWinner = new Map<string, string>();
  for (const candidate of [...normalizedPaths].sort(compareCandidates)) {
    const basename = normalizedCandidate(path.posix.basename(candidate));
    if (!basenameWinner.has(basename)) basenameWinner.set(basename, candidate);
  }

  return (reference: string, currentPath: string): string | null => {
    const normalized = normalizeWikilinkReference(reference);
    const requested = normalized.split("#", 1)[0]!.trim();
    if (!requested) return currentPath;
    const slashRequested = requested.replace(/\\/g, "/");
    const direct = linkableExtension(
      path.posix
        .normalize(slashRequested.replace(/^\/+/, ""))
        .replace(/^(?:\.\.\/)+/, ""),
    );
    const relative = linkableExtension(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(currentPath), slashRequested),
      ),
    );
    return (
      exact.get(normalizedCandidate(relative)) ??
      exact.get(normalizedCandidate(direct)) ??
      basenameWinner.get(normalizedCandidate(path.posix.basename(direct))) ??
      null
    );
  };
}

function plainHeading(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

function contextualExcerpt(block: string, linkOffset: number): string {
  if (block.length <= 720) return block;
  const start = Math.max(0, Math.min(linkOffset - 260, block.length - 720));
  const excerpt = block.slice(start, start + 720).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${
    start + 720 < block.length ? "…" : ""
  }`;
}

export function extractContextualLinks(
  content: string,
  sourcePath: string,
  resolvePath: (reference: string, currentPath: string) => string | null,
): ContextualLinkOccurrence[] {
  const lines = parseMarkdownDocument(content).body.split(/\r?\n/);
  const headings: string[] = [];
  const occurrences: ContextualLinkOccurrence[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      headings.length = level - 1;
      headings[level - 1] = plainHeading(heading[2]!);
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const blockLines = [line];
    const listItem = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    let end = index + 1;
    while (end < lines.length && lines[end]!.trim() !== "") {
      if (/^#{1,6}\s+/.test(lines[end]!)) break;
      const nextListItem = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(lines[end]!);
      if (
        listItem &&
        nextListItem &&
        nextListItem[1]!.length <= listItem[1]!.length
      ) {
        break;
      }
      if (!listItem && nextListItem) break;
      blockLines.push(lines[end]!);
      end += 1;
    }
    const block = blockLines.join("\n");
    const seenTargets = new Set<string>();
    const pattern = /\[\[([^\]\n]+)\]\]/g;
    for (const match of block.matchAll(pattern)) {
      if (match.index > 0 && block[match.index - 1] === "!") continue;
      const reference = normalizeWikilinkReference(match[1]!);
      if (!reference) continue;
      const targetPath = resolvePath(reference, sourcePath);
      if (!targetPath || seenTargets.has(targetPath)) continue;
      seenTargets.add(targetPath);
      occurrences.push({
        targetPath,
        headings: headings.filter(Boolean),
        context: contextualExcerpt(block, match.index),
      });
    }
    index = Math.max(end, index + 1);
  }

  return occurrences;
}
