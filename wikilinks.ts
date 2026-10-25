import path from "node:path";

export interface ResolvedWikilinkPath {
  path: string;
  exists: boolean;
}

export function normalizeWikilinkReference(reference: string): string {
  return reference.split("|", 1)[0]!.trim();
}

export function extractWikilinkReferences(markdown: string): string[] {
  const references = new Set<string>();
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  for (const match of markdown.matchAll(pattern)) {
    if (match.index > 0 && markdown[match.index - 1] === "!") continue;
    const reference = normalizeWikilinkReference(match[1]!);
    if (reference !== "") references.add(reference);
  }
  return [...references];
}

function stripSubpath(reference: string): string {
  const hashIndex = reference.indexOf("#");
  return (hashIndex === -1 ? reference : reference.slice(0, hashIndex)).trim();
}

function withLinkableExtension(value: string): string {
  return /\.(?:md|markdown|tldraw)$/i.test(value) ? value : `${value}.md`;
}

function compareCandidates(a: string, b: string): number {
  const depthDifference = a.split("/").length - b.split("/").length;
  return depthDifference || a.localeCompare(b);
}

/**
 * Where a reference would live if nothing matches it. Callers holding a
 * complete index use this instead of rescanning every path for a known miss.
 */
export function wikilinkFallbackPath(
  reference: string,
  currentPath: string,
): string {
  const requestedFile = stripSubpath(normalizeWikilinkReference(reference));
  if (requestedFile === "") return currentPath.replace(/\\/g, "/");
  const slashRequested = requestedFile.replace(/\\/g, "/");
  const directRequest = withLinkableExtension(
    path.posix
      .normalize(slashRequested.replace(/^\/+/, ""))
      .replace(/^(?:\.\.\/)+/, ""),
  );
  const relativeRequest = withLinkableExtension(
    path.posix.normalize(
      path.posix.join(
        path.posix.dirname(currentPath.replace(/\\/g, "/")),
        slashRequested,
      ),
    ),
  );
  return !relativeRequest.startsWith("../") &&
    !path.posix.isAbsolute(relativeRequest)
    ? relativeRequest
    : directRequest;
}

export function resolveWikilinkPath(
  reference: string,
  currentPath: string,
  availableMarkdownPaths: readonly string[],
): ResolvedWikilinkPath {
  const normalizedCurrentPath = currentPath.replace(/\\/g, "/");
  const currentDirectory = path.posix.dirname(normalizedCurrentPath);
  const requestedFile = stripSubpath(normalizeWikilinkReference(reference));
  if (requestedFile === "") {
    return { path: normalizedCurrentPath, exists: true };
  }

  const slashRequested = requestedFile.replace(/\\/g, "/");
  const directRequest = withLinkableExtension(
    path.posix
      .normalize(slashRequested.replace(/^\/+/, ""))
      .replace(/^(?:\.\.\/)+/, ""),
  );
  const relativeRequest = withLinkableExtension(
    path.posix.normalize(path.posix.join(currentDirectory, slashRequested)),
  );
  const normalizedAvailable = availableMarkdownPaths
    .map((candidate) => candidate.replace(/\\/g, "/"))
    .filter(
      (candidate) =>
        candidate !== ".." &&
        !candidate.startsWith("../") &&
        !path.posix.isAbsolute(candidate),
    );
  const lowerDirect = directRequest.toLocaleLowerCase();
  const lowerRelative = relativeRequest.toLocaleLowerCase();

  const exactRelative = normalizedAvailable.find(
    (candidate) => candidate.toLocaleLowerCase() === lowerRelative,
  );
  if (exactRelative) return { path: exactRelative, exists: true };

  const exactRoot = normalizedAvailable.find(
    (candidate) => candidate.toLocaleLowerCase() === lowerDirect,
  );
  if (exactRoot) return { path: exactRoot, exists: true };

  // Otherwise the candidate sharing the longest trailing run of path segments
  // wins, so `projects/app/notes/x/index` finds `docs/notes/x/index.md` in a
  // workspace mounted below a vault, rather than whichever `index.md` is
  // shallowest. A bare name is the one-segment case: shallowest, then sorted.
  const requestedSegments = lowerDirect.split("/");
  let best: string | undefined;
  let bestShared = 0;
  for (const candidate of normalizedAvailable) {
    const segments = candidate.toLocaleLowerCase().split("/");
    let shared = 0;
    while (
      shared < segments.length &&
      shared < requestedSegments.length &&
      segments[segments.length - 1 - shared] ===
        requestedSegments[requestedSegments.length - 1 - shared]
    ) {
      shared += 1;
    }
    if (
      shared > 0 &&
      (shared > bestShared ||
        (shared === bestShared && compareCandidates(candidate, best!) < 0))
    ) {
      best = candidate;
      bestShared = shared;
    }
  }
  if (best) return { path: best, exists: true };

  const safeFallback =
    !relativeRequest.startsWith("../") && !path.posix.isAbsolute(relativeRequest)
      ? relativeRequest
      : directRequest;
  return { path: safeFallback, exists: false };
}
