import path from "node:path";
import { readFile } from "node:fs/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  decodeLocalMarkdownPath,
  extractLocalMarkdownPaths,
} from "./wikilink-markdown.js";
import {
  extractWikilinkReferences,
  normalizeWikilinkReference,
  resolveWikilinkPath,
} from "./wikilinks.js";
import { createMarkdownExcerpt } from "./preview-markdown.js";
import { extractTldrawPreviewDataUrl } from "./tldraw-preview.js";
import { fetchWebPreview, type WebPreviewResult } from "./web-preview.js";
import {
  createWikilinkPathResolver,
  extractContextualLinks,
} from "./contextual-backlinks.js";
import {
  formatThinkingTrails,
  listThinkingTrails,
  recordThinkingTrail,
  thinkingTrailMigrations,
} from "./thinking-trails-store.js";

const openerSourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().min(1).optional(),
  })
  .strict();

const liveFileTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace"),
      environmentId: z.string().min(1),
      path: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      path: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thread-storage"),
      threadId: z.string().min(1),
      path: z.string(),
    })
    .strict(),
]);

const resolvedLinkSchema = z
  .object({
    reference: z.string(),
    target: liveFileTargetSchema,
    exists: z.boolean(),
  })
  .strict();

const contextualBacklinkSchema = z
  .object({
    sourceTitle: z.string(),
    headings: z.array(z.string()),
    context: z.string(),
    target: liveFileTargetSchema,
    links: z.array(resolvedLinkSchema),
  })
  .strict();

const hoverPreviewSchema = z
  .object({
    content: z.string().nullable(),
    imageDataUrl: z.string().nullable(),
    backlinks: z.array(contextualBacklinkSchema).nullable(),
    truncated: z.boolean(),
    links: z.array(resolvedLinkSchema),
  })
  .strict();

const webPreviewSchema = z
  .object({
    url: z.string().url(),
    title: z.string(),
    siteName: z.string(),
    content: z.string(),
    format: z.enum(["markdown", "text"]),
    truncated: z.boolean(),
  })
  .strict();

const thinkingTrailStepSchema = z
  .object({
    localId: z.string().min(1).max(80),
    parentLocalId: z.string().min(1).max(80).nullable(),
    label: z.string().min(1).max(500),
    target: liveFileTargetSchema.nullable(),
    relation: z.enum(["root", "link", "backlink"]),
    previewMode: z.enum(["note", "backlinks"]),
    enteredAtMs: z.number().int().nonnegative(),
    exitedAtMs: z.number().int().nonnegative(),
    dwellMs: z.number().int().nonnegative().max(3_600_000),
    interactionCount: z.number().int().nonnegative().max(10_000),
    clicked: z.boolean(),
  })
  .strict();

const capturedThinkingTrailSchema = z
  .object({
    threadId: z.string().min(1).nullable(),
    projectId: z.string().min(1).nullable(),
    originKind: z.enum(["file", "chat"]),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative(),
    finishReason: z.enum([
      "hover-chain-exited",
      "context-changed",
      "inactive",
      "page-hidden",
    ]),
    steps: z.array(thinkingTrailStepSchema).min(2).max(64),
  })
  .strict();

const storedThinkingTrailStepSchema = thinkingTrailStepSchema.extend({
  ordinal: z.number().int().nonnegative(),
  parentOrdinal: z.number().int().nonnegative().nullable(),
  depth: z.number().int().nonnegative(),
});

const storedThinkingTrailSchema = z
  .object({
    id: z.number().int().positive(),
    threadId: z.string().nullable(),
    projectId: z.string().nullable(),
    originKind: z.enum(["file", "chat"]),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    finishReason: capturedThinkingTrailSchema.shape.finishReason,
    signalScore: z.number().int().min(0).max(100),
    clickCount: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative(),
    steps: z.array(storedThinkingTrailStepSchema).max(128),
  })
  .strict();

export const rpcContract = defineRpcContract({
  open_markdown: {
    input: z
      .object({
        path: z.string().min(1),
        source: openerSourceSchema,
      })
      .strict(),
    output: z
      .object({
        content: z.string(),
        sha256: z.string(),
      })
      .strict(),
  },
  refresh_markdown: {
    input: z
      .object({
        path: z.string().min(1),
        source: openerSourceSchema,
        knownSha256: z.string().min(1),
      })
      .strict(),
    output: z.discriminatedUnion("changed", [
      z
        .object({
          changed: z.literal(false),
          sha256: z.string(),
        })
        .strict(),
      z
        .object({
          changed: z.literal(true),
          content: z.string(),
          sha256: z.string(),
        })
        .strict(),
    ]),
  },
  resolve_markdown_links: {
    input: z
      .object({
        path: z.string().min(1),
        source: openerSourceSchema,
        content: z.string(),
      })
      .strict(),
    output: z.object({ links: z.array(resolvedLinkSchema) }).strict(),
  },
  save_markdown: {
    input: z
      .object({
        path: z.string().min(1),
        source: openerSourceSchema,
        content: z.string(),
        expectedSha256: z.string().nullable().optional(),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z
        .object({
          outcome: z.literal("written"),
          sha256: z.string(),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("conflict"),
          currentSha256: z.string().nullable(),
        })
        .strict(),
    ]),
  },
  resolve_chat_wikilink: {
    input: z
      .object({
        threadId: z.string().min(1),
        reference: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        target: liveFileTargetSchema.nullable(),
        exists: z.boolean(),
      })
      .strict(),
  },
  preview_file: {
    input: z
      .object({
        target: liveFileTargetSchema,
        backlinks: z.boolean().optional(),
      })
      .strict(),
    output: hoverPreviewSchema,
  },
  preview_url: {
    input: z.object({ url: z.string().url().max(8_192) }).strict(),
    output: webPreviewSchema,
  },
  preview_chat_wikilink: {
    input: z
      .object({
        threadId: z.string().min(1),
        reference: z.string().min(1),
        backlinks: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        target: liveFileTargetSchema.nullable(),
        exists: z.boolean(),
        content: z.string().nullable(),
        imageDataUrl: z.string().nullable(),
        backlinks: z.array(contextualBacklinkSchema).nullable(),
        truncated: z.boolean(),
        links: z.array(resolvedLinkSchema),
      })
      .strict(),
  },
  autocomplete_wikilinks: {
    input: z
      .object({
        threadId: z.string().min(1),
        query: z.string().max(160),
      })
      .strict(),
    output: z
      .array(
        z
          .object({
            reference: z.string(),
            label: z.string(),
            directory: z.string(),
          })
          .strict(),
      )
      .max(12),
  },
  record_thinking_trail: {
    input: z.object({ trail: capturedThinkingTrailSchema }).strict(),
    output: z.object({ id: z.number().int().positive() }).strict(),
  },
  list_thinking_trails: {
    input: z
      .object({
        threadId: z.string().min(1).nullable().optional(),
        note: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    output: z.object({ trails: z.array(storedThinkingTrailSchema) }).strict(),
  },
});

type OpenerSource = z.infer<typeof openerSourceSchema>;
type LiveFileTarget = z.infer<typeof liveFileTargetSchema>;

interface OpenContext {
  absolutePath: string;
  currentRelativePath: string;
  rootPath: string;
  hostId: string;
  targetFor(relativePath: string): LiveFileTarget;
}

const AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const autocompleteIndexCache = new Map<
  string,
  {
    expiresAt: number;
    promise: Promise<{ paths: string[]; truncated: boolean }>;
  }
>();
const BACKLINK_INDEX_TTL_MS = 45_000;
const WEB_PREVIEW_CACHE_TTL_MS = 5 * 60_000;
const webPreviewCache = new Map<
  string,
  { expiresAt: number; promise: Promise<WebPreviewResult> }
>();
const backlinkIndexCache = new Map<
  string,
  {
    expiresAt: number;
    promise: Promise<
      Map<
        string,
        Array<{
          sourcePath: string;
          sourceTitle: string;
          headings: string[];
          context: string;
        }>
      >
    >;
  }
>();

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function cachedWebPreview(url: string): Promise<WebPreviewResult> {
  const now = Date.now();
  const cached = webPreviewCache.get(url);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = fetchWebPreview(url);
  webPreviewCache.set(url, {
    expiresAt: now + WEB_PREVIEW_CACHE_TTL_MS,
    promise,
  });
  promise.catch(() => {
    if (webPreviewCache.get(url)?.promise === promise) webPreviewCache.delete(url);
  });
  if (webPreviewCache.size > 128) {
    webPreviewCache.delete(webPreviewCache.keys().next().value!);
  }
  return promise;
}

function hostPathApi(value: string): path.PlatformPath {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)
    ? path.win32
    : path.posix;
}

function normalizeHostPath(value: string): string {
  return hostPathApi(value).normalize(value);
}

function requireRelativePath(value: string): string {
  const slashPath = value.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slashPath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("Workspace file paths must stay inside their source root");
  }
  return normalized;
}

function joinHostPath(rootPath: string, relativePath: string): string {
  return hostPathApi(rootPath).join(rootPath, ...relativePath.split("/"));
}

function relativePathWithinRoot(
  rootPath: string,
  absolutePath: string,
): string | null {
  const rootApi = hostPathApi(rootPath);
  if (rootApi !== hostPathApi(absolutePath)) return null;
  const relativePath = rootApi.relative(rootPath, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${rootApi.sep}`) ||
    rootApi.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(rootApi.sep).join("/");
}

async function exactPathExists(
  bb: BbPluginApi,
  hostId: string,
  absolutePath: string,
): Promise<boolean> {
  const result = await bb.sdk.hosts.pathsExist({
    hostId,
    paths: [absolutePath],
  });
  return result.existence[absolutePath] ?? false;
}

async function resolveLocalMarkdownLink(
  bb: BbPluginApi,
  localPath: string,
  context: OpenContext,
): Promise<{
  reference: string;
  target: LiveFileTarget;
  exists: boolean;
}> {
  if (isAbsoluteHostPath(localPath)) {
    const absolutePath = normalizeHostPath(localPath);
    const relativePath = relativePathWithinRoot(context.rootPath, absolutePath);
    return {
      reference: localPath,
      target: relativePath
        ? context.targetFor(relativePath)
        : { kind: "host", hostId: context.hostId, path: absolutePath },
      exists: await exactPathExists(bb, context.hostId, absolutePath),
    };
  }

  const currentDirectory = path.posix.dirname(context.currentRelativePath);
  const relativePath = requireRelativePath(
    path.posix.join(currentDirectory, localPath.replace(/\\/g, "/")),
  );
  const absolutePath = joinHostPath(context.rootPath, relativePath);
  return {
    reference: localPath,
    target: context.targetFor(relativePath),
    exists: await exactPathExists(bb, context.hostId, absolutePath),
  };
}

async function listLinkablePaths(
  bb: BbPluginApi,
  hostId: string,
  rootPath: string,
  query?: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const index = await bb.sdk.files.listPaths({
    hostId,
    path: rootPath,
    includeFiles: true,
    includeDirectories: false,
    limit: query ? 200 : 10_000,
    ...(query ? { query } : {}),
  });
  return {
    paths: index.paths
      .filter(
        (entry) =>
          entry.kind === "file" && /\.(?:md|markdown|tldraw)$/i.test(entry.path),
      )
      .map((entry) => entry.path.replace(/\\/g, "/")),
    truncated: index.truncated,
  };
}

function wikilinkSearchQuery(reference: string): string {
  return normalizeWikilinkReference(reference).split("#", 1)[0]!.trim();
}

async function resolveChatWikilink(
  bb: BbPluginApi,
  threadId: string,
  reference: string,
): Promise<{ target: LiveFileTarget | null; exists: boolean }> {
  const context = await resolveThreadContext(bb, threadId);
  if (!context) return { target: null, exists: false };
  const localPath = decodeLocalMarkdownPath(reference);
  if (localPath) {
    const resolved = await resolveLocalMarkdownLink(bb, localPath, context);
    return { target: resolved.target, exists: resolved.exists };
  }
  const index = await listLinkablePaths(
    bb,
    context.hostId,
    context.rootPath,
    wikilinkSearchQuery(reference),
  );
  const resolved = resolveWikilinkPath(
    reference,
    context.currentRelativePath,
    index.paths,
  );
  return {
    target: context.targetFor(resolved.path),
    exists: resolved.exists,
  };
}

async function resolveThreadContext(
  bb: BbPluginApi,
  threadId: string,
): Promise<OpenContext | null> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId) {
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (!environment.path || !environment.hostId) {
      return null;
    }
    const rootPath = normalizeHostPath(environment.path);
    return {
      absolutePath: joinHostPath(rootPath, "__chat__.md"),
      currentRelativePath: "__chat__.md",
      rootPath,
      hostId: environment.hostId,
      targetFor: (relativePath) => ({
        kind: "workspace",
        environmentId: thread.environmentId!,
        path: relativePath,
      }),
    };
  }

  const hostId = (await bb.sdk.system.config()).primaryHostId;
  if (!hostId) return null;
  const project = await bb.sdk.projects.get({ projectId: thread.projectId });
  const sources = project.sources.filter((source) => source.hostId === hostId);
  if (sources.length !== 1) return null;
  const rootPath = normalizeHostPath(sources[0]!.path);
  if (!isAbsoluteHostPath(rootPath)) return null;
  return {
    absolutePath: joinHostPath(rootPath, "__chat__.md"),
    currentRelativePath: "__chat__.md",
    rootPath,
    hostId,
    targetFor: (relativePath) => ({
      kind: "host",
      hostId,
      path: joinHostPath(rootPath, relativePath),
    }),
  };
}

function normalizeAutocompleteText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function subsequenceGap(needle: string, haystack: string): number | null {
  let needleIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (
    let index = 0;
    index < haystack.length && needleIndex < needle.length;
    index += 1
  ) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (firstMatch === -1) firstMatch = index;
    lastMatch = index;
    needleIndex += 1;
  }
  return needleIndex === needle.length
    ? lastMatch - firstMatch + 1 - needle.length
    : null;
}

function tokenMatchScore(queryToken: string, candidate: string): number {
  if (candidate === queryToken) return 0;
  if (candidate.startsWith(queryToken)) {
    return 0.15 + (candidate.length - queryToken.length) * 0.01;
  }
  const substringIndex = candidate.indexOf(queryToken);
  if (substringIndex !== -1) return 0.5 + substringIndex * 0.03;

  if (queryToken.length >= 3) {
    const gap = subsequenceGap(queryToken, candidate);
    if (gap !== null) return 0.9 + gap * 0.08;
    if (
      candidate[0] === queryToken[0] &&
      Math.abs(candidate.length - queryToken.length) <= 2
    ) {
      const distance = editDistance(queryToken, candidate);
      if (
        distance <= Math.min(2, Math.floor(queryToken.length / 3) + 1) &&
        distance / Math.max(queryToken.length, candidate.length) <= 0.4
      ) {
        return 1.2 + distance * 0.3;
      }
    }
  }
  return Number.POSITIVE_INFINITY;
}

function autocompleteScore(reference: string, query: string): number {
  const normalizedQuery = normalizeAutocompleteText(query);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const segments = reference.split("/");
  const normalizedLabel = normalizeAutocompleteText(segments.at(-1)!);
  const labelWords = normalizedLabel.split(" ").filter(Boolean);
  const directoryWords = normalizeAutocompleteText(
    segments.slice(0, -1).join(" "),
  )
    .split(" ")
    .filter(Boolean);
  let score = 0;
  for (const queryToken of queryTokens) {
    const phraseIndex = normalizedLabel.indexOf(queryToken);
    const phraseScore =
      phraseIndex === -1 ? Number.POSITIVE_INFINITY : 0.5 + phraseIndex * 0.03;
    const wordScore = Math.min(
      ...labelWords.map((word) => tokenMatchScore(queryToken, word)),
    );
    const directoryScore =
      directoryWords.length === 0
        ? Number.POSITIVE_INFINITY
        : Math.min(
            ...directoryWords.map((word) =>
              tokenMatchScore(queryToken, word),
            ),
          ) + 0.35;
    const best = Math.min(phraseScore, wordScore, directoryScore);
    if (!Number.isFinite(best)) return Number.POSITIVE_INFINITY;
    score += best;
  }
  if (normalizedLabel.startsWith(normalizedQuery)) score -= 0.75;
  else if (normalizedLabel.includes(normalizedQuery)) score -= 0.4;
  return score / Math.max(1, queryTokens.length);
}

async function cachedAutocompleteIndex(
  bb: BbPluginApi,
  context: OpenContext,
) {
  const cacheKey = `${context.hostId}\0${context.rootPath}`;
  const now = Date.now();
  const cached = autocompleteIndexCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt <= now) {
      cached.expiresAt = now + AUTOCOMPLETE_CACHE_TTL_MS;
      const refresh = listLinkablePaths(bb, context.hostId, context.rootPath);
      refresh.then(
        (index) => {
          autocompleteIndexCache.set(cacheKey, {
            expiresAt: Date.now() + AUTOCOMPLETE_CACHE_TTL_MS,
            promise: Promise.resolve(index),
          });
        },
        () => {
          cached.expiresAt = Date.now() + AUTOCOMPLETE_CACHE_TTL_MS;
        },
      );
    }
    return cached.promise;
  }
  const promise = listLinkablePaths(bb, context.hostId, context.rootPath);
  autocompleteIndexCache.set(cacheKey, {
    expiresAt: now + AUTOCOMPLETE_CACHE_TTL_MS,
    promise,
  });
  promise.catch(() => autocompleteIndexCache.delete(cacheKey));
  return promise;
}

async function autocompleteWikilinks(
  bb: BbPluginApi,
  threadId: string,
  query: string,
) {
  const normalizedQuery = query.trim();
  const context = await resolveThreadContext(bb, threadId);
  if (!context) return [];
  const index = await cachedAutocompleteIndex(bb, context);
  if (normalizedQuery === "") return [];
  let paths = index.paths;
  if (index.truncated) {
    const longestToken = normalizeAutocompleteText(normalizedQuery)
      .split(" ")
      .sort((left, right) => right.length - left.length)[0];
    if (longestToken) {
      const targeted = await listLinkablePaths(
        bb,
        context.hostId,
        context.rootPath,
        longestToken,
      );
      paths = [...new Set([...paths, ...targeted.paths])];
    }
  }
  return paths
    .map((filePath) => {
      const reference = filePath.replace(/\.(?:md|markdown)$/i, "");
      const segments = reference.split("/");
      return {
        reference,
        label: segments.at(-1)!,
        directory: segments.length > 1 ? `${segments.slice(0, -1).join("/")}/` : "",
        score: autocompleteScore(reference, normalizedQuery),
      };
    })
    .filter((suggestion) => Number.isFinite(suggestion.score))
    .sort((left, right) => {
      return (
        left.score - right.score ||
        left.label.length - right.label.length ||
        left.reference.localeCompare(right.reference)
      );
    })
    .slice(0, 12)
    .map(({ score: _score, ...suggestion }) => suggestion);
}

async function readUtf8File(
  bb: BbPluginApi,
  hostId: string,
  absolutePath: string,
  rootPath: string,
): Promise<string> {
  const file = await bb.sdk.files.read({
    hostId,
    path: absolutePath,
    rootPath,
  });
  return file.contentEncoding === "base64"
    ? Buffer.from(file.content, "base64").toString("utf8")
    : file.content;
}

async function readFileBuffer(
  bb: BbPluginApi,
  hostId: string,
  absolutePath: string,
  rootPath: string,
): Promise<Buffer> {
  const file = await bb.sdk.files.read({
    hostId,
    path: absolutePath,
    rootPath,
  });
  return file.contentEncoding === "base64"
    ? Buffer.from(file.content, "base64")
    : Buffer.from(file.content, "utf8");
}

function noteTitle(filePath: string): string {
  return path.posix
    .basename(filePath)
    .replace(/\.(?:md|markdown)$/i, "");
}

async function readBacklinkSource(
  bb: BbPluginApi,
  context: OpenContext,
  relativePath: string,
): Promise<string> {
  const absolutePath = joinHostPath(context.rootPath, relativePath);
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return readUtf8File(bb, context.hostId, absolutePath, context.rootPath);
  }
}

async function buildBacklinkIndex(
  bb: BbPluginApi,
  context: OpenContext,
  availablePaths: readonly string[],
) {
  const markdownPaths = availablePaths.filter((filePath) =>
    /\.(?:md|markdown)$/i.test(filePath),
  );
  const resolvePath = createWikilinkPathResolver(availablePaths);
  const backlinks = new Map<
    string,
    Array<{
      sourcePath: string;
      sourceTitle: string;
      headings: string[];
      context: string;
    }>
  >();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(24, markdownPaths.length) },
    async () => {
      for (;;) {
        const sourcePath = markdownPaths[cursor];
        cursor += 1;
        if (!sourcePath) return;
        try {
          const content = await readBacklinkSource(bb, context, sourcePath);
          for (const occurrence of extractContextualLinks(
            content,
            sourcePath,
            resolvePath,
          )) {
            const key = occurrence.targetPath.toLocaleLowerCase();
            const entries = backlinks.get(key) ?? [];
            entries.push({
              sourcePath,
              sourceTitle: noteTitle(sourcePath),
              headings: occurrence.headings,
              context: occurrence.context,
            });
            backlinks.set(key, entries);
          }
        } catch {
          continue;
        }
      }
    },
  );
  await Promise.all(workers);
  for (const entries of backlinks.values()) {
    entries.sort(
      (left, right) =>
        left.sourceTitle.localeCompare(right.sourceTitle) ||
        left.sourcePath.localeCompare(right.sourcePath),
    );
  }
  return backlinks;
}

async function contextualBacklinks(
  bb: BbPluginApi,
  context: OpenContext,
): Promise<{
  backlinks: Array<{
    sourceTitle: string;
    headings: string[];
    context: string;
    target: LiveFileTarget;
    links: Array<{
      reference: string;
      target: LiveFileTarget;
      exists: boolean;
    }>;
  }>;
  truncated: boolean;
}> {
  const cacheKey = `${context.hostId}\0${context.rootPath}`;
  const now = Date.now();
  let cached = backlinkIndexCache.get(cacheKey);
  if (!cached || cached.expiresAt <= now) {
    const promise = cachedAutocompleteIndex(bb, context).then((index) =>
      buildBacklinkIndex(bb, context, index.paths),
    );
    cached = {
      expiresAt: now + BACKLINK_INDEX_TTL_MS,
      promise,
    };
    backlinkIndexCache.set(cacheKey, cached);
    promise.catch(() => backlinkIndexCache.delete(cacheKey));
  }
  const index = await cached.promise;
  const all = (index.get(context.currentRelativePath.toLocaleLowerCase()) ?? [])
    .filter(
      (entry) =>
        entry.sourcePath.toLocaleLowerCase() !==
        context.currentRelativePath.toLocaleLowerCase(),
    );
  const linkIndex = await cachedAutocompleteIndex(bb, context);
  const selected = all.slice(0, 16);
  return {
    backlinks: await Promise.all(
      selected.map(async (entry) => {
        const sourceContext: OpenContext = {
          ...context,
          absolutePath: joinHostPath(context.rootPath, entry.sourcePath),
          currentRelativePath: entry.sourcePath,
        };
        return {
          sourceTitle: entry.sourceTitle,
          headings: entry.headings,
          context: entry.context,
          target: context.targetFor(entry.sourcePath),
          links: await resolveLinks(
            bb,
            entry.context,
            sourceContext,
            linkIndex,
          ),
        };
      }),
    ),
    truncated: all.length > 16,
  };
}

async function previewFile(
  bb: BbPluginApi,
  target: LiveFileTarget,
  showBacklinks = false,
): Promise<{
  content: string | null;
  imageDataUrl: string | null;
  backlinks: Array<{
    sourceTitle: string;
    headings: string[];
    context: string;
    target: LiveFileTarget;
    links: Array<{
      reference: string;
      target: LiveFileTarget;
      exists: boolean;
    }>;
  }> | null;
  truncated: boolean;
  links: Array<{
    reference: string;
    target: LiveFileTarget;
    exists: boolean;
  }>;
}> {
  try {
    const context = await resolveTargetContext(bb, target);
    if (/\.tldraw$/i.test(context.absolutePath)) {
      const archive = await readFileBuffer(
        bb,
        context.hostId,
        context.absolutePath,
        context.rootPath,
      );
      return {
        content: null,
        imageDataUrl: extractTldrawPreviewDataUrl(archive),
        backlinks: null,
        truncated: false,
        links: [],
      };
    }
    if (showBacklinks) {
      const result = await contextualBacklinks(bb, context);
      return {
        content: null,
        imageDataUrl: null,
        backlinks: result.backlinks,
        truncated: result.truncated,
        links: [],
      };
    }
    const [content, index] = await Promise.all([
      readUtf8File(
        bb,
        context.hostId,
        context.absolutePath,
        context.rootPath,
      ),
      cachedAutocompleteIndex(bb, context),
    ]);
    const excerpt = createMarkdownExcerpt(content);
    return {
      ...excerpt,
      imageDataUrl: null,
      backlinks: null,
      links: await resolveLinks(bb, excerpt.content, context, index),
    };
  } catch {
    return {
      content: null,
      imageDataUrl: null,
      backlinks: showBacklinks ? [] : null,
      truncated: false,
      links: [],
    };
  }
}

async function resolveTargetContext(
  bb: BbPluginApi,
  target: LiveFileTarget,
): Promise<OpenContext> {
  if (target.kind === "workspace") {
    const environment = await bb.sdk.environments.get({
      environmentId: target.environmentId,
    });
    if (!environment.path || !environment.hostId) {
      throw new Error("This environment has no readable workspace");
    }
    const currentRelativePath = requireRelativePath(target.path);
    return {
      absolutePath: joinHostPath(environment.path, currentRelativePath),
      currentRelativePath,
      rootPath: environment.path,
      hostId: environment.hostId,
      targetFor: (relativePath) => ({
        kind: "workspace",
        environmentId: target.environmentId,
        path: relativePath,
      }),
    };
  }

  if (target.kind === "thread-storage") {
    const currentRelativePath = requireRelativePath(target.path);
    const storage = await bb.sdk.threads.storageLocation({
      threadId: target.threadId,
    });
    const rootPath = normalizeHostPath(storage.storageRootPath);
    return {
      absolutePath: joinHostPath(rootPath, currentRelativePath),
      currentRelativePath,
      rootPath,
      hostId: storage.hostId,
      targetFor: (relativePath) => ({
        kind: "thread-storage",
        threadId: target.threadId,
        path: relativePath,
      }),
    };
  }

  if (!isAbsoluteHostPath(target.path)) {
    throw new Error("Host file paths must be absolute");
  }
  const absolutePath = normalizeHostPath(target.path);
  const pathApi = hostPathApi(absolutePath);
  const rootPath = pathApi.dirname(absolutePath);
  return {
    absolutePath,
    currentRelativePath: pathApi.basename(absolutePath),
    rootPath,
    hostId: target.hostId,
    targetFor: (relativePath) => ({
      kind: "host",
      hostId: target.hostId,
      path: joinHostPath(rootPath, relativePath),
    }),
  };
}

async function resolveLinks(
  bb: BbPluginApi,
  content: string,
  context: OpenContext,
  index: { paths: readonly string[]; truncated: boolean },
) {
  const wikilinks = extractWikilinkReferences(content).map(
    async (reference) => {
      let availablePaths = index.paths;
      if (index.truncated) {
        const targetedIndex = await listLinkablePaths(
          bb,
          context.hostId,
          context.rootPath,
          wikilinkSearchQuery(reference),
        );
        availablePaths = [...targetedIndex.paths, ...index.paths];
      }
      const resolved = resolveWikilinkPath(
        reference,
        context.currentRelativePath,
        availablePaths,
      );
      return {
        reference,
        target: context.targetFor(resolved.path),
        exists: resolved.exists,
      };
    },
  );
  const markdownLinks = extractLocalMarkdownPaths(content).map((localPath) =>
    resolveLocalMarkdownLink(bb, localPath, context),
  );
  const resolved = await Promise.all([...wikilinks, ...markdownLinks]);
  return [...new Map(resolved.map((link) => [link.reference, link])).values()];
}

async function resolveOpenContext(
  bb: BbPluginApi,
  source: OpenerSource,
  filePath: string,
): Promise<OpenContext> {
  if (source.kind === "workspace" && source.environmentId) {
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });
    if (!environment.path || !environment.hostId) {
      throw new Error("This environment has no readable workspace");
    }
    const currentRelativePath = requireRelativePath(filePath);
    return {
      absolutePath: joinHostPath(environment.path, currentRelativePath),
      currentRelativePath,
      rootPath: environment.path,
      hostId: environment.hostId,
      targetFor: (relativePath) => ({
        kind: "workspace",
        environmentId: source.environmentId!,
        path: relativePath,
      }),
    };
  }

  if (source.kind === "workspace" && source.projectId) {
    const hostId =
      source.experimental_hostId ??
      (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("This project has no primary host");
    const project = await bb.sdk.projects.get({ projectId: source.projectId });
    const matchingSources = project.sources.filter(
      (projectSource) => projectSource.hostId === hostId,
    );
    if (matchingSources.length !== 1) {
      throw new Error(
        matchingSources.length === 0
          ? "This project has no workspace on the selected host"
          : "This project has multiple workspaces on the selected host",
      );
    }
    const rootPath = normalizeHostPath(matchingSources[0]!.path);
    if (!isAbsoluteHostPath(rootPath)) {
      throw new Error("This project has no absolute workspace path");
    }
    const currentRelativePath = requireRelativePath(filePath);
    return {
      absolutePath: joinHostPath(rootPath, currentRelativePath),
      currentRelativePath,
      rootPath,
      hostId,
      targetFor: (relativePath) => ({
        kind: "host",
        hostId,
        path: joinHostPath(rootPath, relativePath),
      }),
    };
  }

  if (source.kind === "host") {
    if (!isAbsoluteHostPath(filePath)) {
      throw new Error("Host file paths must be absolute");
    }
    const absolutePath = normalizeHostPath(filePath);
    const pathApi = hostPathApi(absolutePath);
    const rootPath = pathApi.dirname(absolutePath);
    const hostId =
      source.experimental_hostId ??
      (await bb.sdk.system.config()).primaryHostId;
    if (!hostId) throw new Error("This file has no host");
    const currentRelativePath = pathApi.basename(absolutePath);
    return {
      absolutePath,
      currentRelativePath,
      rootPath,
      hostId,
      targetFor: (relativePath) => ({
        kind: "host",
        hostId,
        path: joinHostPath(rootPath, relativePath),
      }),
    };
  }

  if (source.kind === "thread-storage") {
    if (!source.threadId) {
      throw new Error("Thread-storage files require a thread ID");
    }
    const currentRelativePath = requireRelativePath(filePath);
    const storage = await bb.sdk.threads.storageLocation({
      threadId: source.threadId,
    });
    const rootPath = normalizeHostPath(storage.storageRootPath);
    return {
      absolutePath: joinHostPath(rootPath, currentRelativePath),
      currentRelativePath,
      rootPath,
      hostId: storage.hostId,
      targetFor: (relativePath) => ({
        kind: "thread-storage",
        threadId: source.threadId!,
        path: relativePath,
      }),
    };
  }

  throw new Error("This Markdown source cannot be opened by Obsidian at Home");
}

export default async function plugin(bb: BbPluginApi) {
  autocompleteIndexCache.clear();
  backlinkIndexCache.clear();
  webPreviewCache.clear();
  // Non-secret toggle read by the frontend through useSettings().
  bb.settings.define({
    documentBacklinks: {
      type: "boolean",
      label: "Show backlinks at the bottom of open notes",
      description:
        "Render linked and unlinked mentions under the note preview, sourced from the vault-graph plugin when it is installed.",
      default: true,
    },
  });
  const trailDatabase = bb.storage.database();
  bb.storage.migrate(trailDatabase, thinkingTrailMigrations);
  bb.rpc.register(rpcContract, {
    async open_markdown({ path: filePath, source }) {
      const context = await resolveOpenContext(bb, source, filePath);
      const file = await bb.sdk.files.read({
        hostId: context.hostId,
        path: context.absolutePath,
        rootPath: context.rootPath,
      });
      const content =
        file.contentEncoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf8")
          : file.content;
      return {
        content,
        sha256: file.sha256,
      };
    },
    async refresh_markdown({ path: filePath, source, knownSha256 }) {
      const context = await resolveOpenContext(bb, source, filePath);
      const file = await bb.sdk.files.read({
        hostId: context.hostId,
        path: context.absolutePath,
        rootPath: context.rootPath,
      });
      if (file.sha256 === knownSha256) {
        return { changed: false as const, sha256: file.sha256 };
      }
      return {
        changed: true as const,
        content:
          file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content,
        sha256: file.sha256,
      };
    },
    async resolve_markdown_links({ path: filePath, source, content }) {
      const context = await resolveOpenContext(bb, source, filePath);
      const index = await cachedAutocompleteIndex(bb, context);
      return { links: await resolveLinks(bb, content, context, index) };
    },
    async save_markdown({
      path: filePath,
      source,
      content,
      expectedSha256,
    }) {
      const context = await resolveOpenContext(bb, source, filePath);
      const result = await bb.sdk.files.write({
        hostId: context.hostId,
        path: context.absolutePath,
        rootPath: context.rootPath,
        content,
        contentEncoding: "utf8",
        createParents: false,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });
      if (result.outcome === "conflict") {
        return result;
      }
      backlinkIndexCache.delete(`${context.hostId}\0${context.rootPath}`);
      return {
        outcome: "written" as const,
        sha256: result.sha256,
      };
    },
    async resolve_chat_wikilink({ threadId, reference }) {
      return resolveChatWikilink(bb, threadId, reference);
    },
    async preview_file({ target, backlinks }) {
      return previewFile(bb, target, backlinks);
    },
    async preview_url({ url }) {
      return cachedWebPreview(url);
    },
    async preview_chat_wikilink({ threadId, reference, backlinks }) {
      const resolved = await resolveChatWikilink(bb, threadId, reference);
      const preview = resolved.target
        ? await previewFile(bb, resolved.target, backlinks)
        : {
            content: null,
            imageDataUrl: null,
            backlinks: backlinks ? [] : null,
            truncated: false,
            links: [],
          };
      return {
        ...resolved,
        exists:
          resolved.exists ||
          preview.content !== null ||
          preview.imageDataUrl !== null,
        ...preview,
      };
    },
    async autocomplete_wikilinks({ threadId, query }) {
      return autocompleteWikilinks(bb, threadId, query);
    },
    async record_thinking_trail({ trail }) {
      return { id: recordThinkingTrail(trailDatabase, trail) };
    },
    async list_thinking_trails({ threadId, note, limit }) {
      return {
        trails: listThinkingTrails(trailDatabase, {
          threadId,
          note,
          limit: limit ?? 20,
        }),
      };
    },
  });
  bb.agents.registerTool({
    name: "query_thinking_trails",
    description:
      "Find recent paths the user deliberately explored through linked notes and contextual backlinks. Trails preserve time, branching, dwell, and stronger click signals.",
    instructions:
      "Use this when earlier navigation may reveal how the user connected notes. Treat hover as curiosity and clicks as stronger interest, not endorsement.",
    presentation: {
      label: {
        pending: "Searching thinking trails",
        completed: "Searched thinking trails",
      },
    },
    parameters: z
      .object({
        note: z
          .string()
          .max(500)
          .optional()
          .describe("Optional note name or path to find within trails"),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    async execute({ note, limit }) {
      return formatThinkingTrails(
        listThinkingTrails(trailDatabase, {
          note,
          limit: limit ?? 10,
        }),
      );
    },
  });
  bb.agents.configure(() => ({
    tools: ["query_thinking_trails"],
    skills: ["obsidian-at-home"],
    instructions:
      "Thinking trails record note paths the user explored. Hover indicates curiosity; a clicked step is a stronger attention signal. Query them when reconstructing prior working context would help.",
  }));
}
