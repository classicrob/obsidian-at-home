import { extractThreadBacklinks, loadThreadMessages } from "./thread-backlinks.js";
import { mediaResponse } from "./media-response.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  mediaKind,
  decodeLocalMarkdownPath,
  extractLocalMarkdownPaths,
} from "./wikilink-markdown.js";
import {
  extractWikilinkReferences,
  normalizeWikilinkReference,
  resolveWikilinkPath,
  wikilinkFallbackPath,
} from "./wikilinks.js";
import { stripYamlFrontmatter } from "./preview-markdown.js";
import { extractTldrawPreviewDataUrl } from "./tldraw-preview.js";
import { fetchWebPreview, type WebPreviewResult } from "./web-preview.js";
import {
  cachedWikilinkPathResolver,
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
        createIfMissing: z.boolean().optional(),
      })
      .strict(),
    output: z
      .object({
        content: z.string(),
        sha256: z.string(),
        created: z.boolean().optional(),
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
  resolve_media: {
    input: z.object({ path: z.string().min(1), source: openerSourceSchema, reference: z.string().min(1) }).strict(),
    output: z.object({ url: z.string().nullable(), expiresAtMs: z.number() }).strict(),
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
        threadId: z.string().min(1).optional(),
        source: openerSourceSchema.optional(),
        path: z.string().optional(),
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
  thread_backlink_context: {
    input: z.object({ threadId: z.string().min(1), path: z.string().min(1), source: openerSourceSchema }).strict(),
    output: z.object({
      occurrences: z.array(z.object({ messageId: z.string(), role: z.enum(["user", "assistant"]), createdAt: z.number(), context: z.string(), preview: z.string(), focusLabel: z.string(), userPrompt: z.string().nullable() })),
      truncated: z.boolean(),
      links: z.array(resolvedLinkSchema),
    }).strict(),
  },
  preview_url: {
    input: z.object({ url: z.string().url().max(8_192) }).strict(),
    output: webPreviewSchema,
  },
  preview_chat_wikilink: {
    input: z
      .object({
        threadId: z.string().min(1).optional(),
        source: openerSourceSchema.optional(),
        path: z.string().optional(),
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
        threadId: z.string().min(1).optional(),
        source: openerSourceSchema.optional(),
        path: z.string().optional(),
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

const LOCATION_CACHE_TTL_MS = 60_000;
const environmentCache = new Map<
  string,
  { expiresAt: number; promise: Promise<{ path: string | null; hostId: string | null }> }
>();
const threadStorageCache = new Map<
  string,
  { expiresAt: number; promise: Promise<{ storageRootPath: string; hostId: string }> }
>();

/** Memoizes a lookup whose answer barely changes but is asked on every hover. */
function memoizeLookup<T>(
  cache: Map<string, { expiresAt: number; promise: Promise<T> }>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = load();
  cache.set(key, { expiresAt: now + LOCATION_CACHE_TTL_MS, promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

function cachedEnvironment(bb: BbPluginApi, environmentId: string) {
  return memoizeLookup(environmentCache, environmentId, async () => {
    const environment = await bb.sdk.environments.get({ environmentId });
    return { path: environment.path, hostId: environment.hostId };
  });
}

function cachedThreadStorage(bb: BbPluginApi, threadId: string) {
  return memoizeLookup(threadStorageCache, threadId, () =>
    bb.sdk.threads.storageLocation({ threadId }),
  );
}

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

interface PlannedLocalMarkdownLink {
  reference: string;
  target: LiveFileTarget;
  absolutePath: string;
}

function planLocalMarkdownLink(
  localPath: string,
  context: OpenContext,
): PlannedLocalMarkdownLink {
  if (isAbsoluteHostPath(localPath)) {
    const absolutePath = normalizeHostPath(localPath);
    const relativePath = relativePathWithinRoot(context.rootPath, absolutePath);
    return {
      reference: localPath,
      target: relativePath
        ? context.targetFor(relativePath)
        : { kind: "host", hostId: context.hostId, path: absolutePath },
      absolutePath,
    };
  }

  const currentDirectory = path.posix.dirname(context.currentRelativePath);
  const relativePath = requireRelativePath(
    path.posix.join(currentDirectory, localPath.replace(/\\/g, "/")),
  );
  return {
    reference: localPath,
    target: context.targetFor(relativePath),
    absolutePath: joinHostPath(context.rootPath, relativePath),
  };
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
  const [resolved] = await resolveLocalMarkdownLinks(bb, [localPath], context);
  return resolved!;
}

/** Resolves a whole note's relative markdown links in one existence check. */
async function resolveLocalMarkdownLinks(
  bb: BbPluginApi,
  localPaths: readonly string[],
  context: OpenContext,
): Promise<
  Array<{ reference: string; target: LiveFileTarget; exists: boolean }>
> {
  const plans: PlannedLocalMarkdownLink[] = [];
  for (const localPath of localPaths) {
    try {
      plans.push(planLocalMarkdownLink(localPath, context));
    } catch {
      continue;
    }
  }
  if (plans.length === 0) return [];
  const { existence } = await bb.sdk.hosts.pathsExist({
    hostId: context.hostId,
    paths: [...new Set(plans.map((plan) => plan.absolutePath))],
  });
  return plans.map(({ absolutePath, ...plan }) => ({
    ...plan,
    exists: existence[absolutePath] ?? false,
  }));
}

const LINKABLE_FILE_PATTERN = /\.(?:md|markdown|tldraw)$/i;
const LOCAL_WALK_MAX_ENTRIES = 200_000;
const LOCAL_ROOT_PROBE_TTL_MS = 5 * 60_000;
const localRootProbes = new Map<
  string,
  { expiresAt: number; promise: Promise<boolean> }
>();

/**
 * Whether `rootPath` on `hostId` is the very same directory this plugin server
 * can read directly, checked by comparing the host's own listing of the root
 * against the local one. Walking the vault locally is far cheaper than listing
 * it over the host RPC, but only valid if both point at the same tree.
 */
async function hostRootIsLocal(
  bb: BbPluginApi,
  hostId: string,
  rootPath: string,
): Promise<boolean> {
  const key = `${hostId}\0${rootPath}`;
  const now = Date.now();
  const cached = localRootProbes.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = (async () => {
    try {
      const [remote, local] = await Promise.all([
        bb.sdk.hosts.directory({ hostId, path: rootPath }),
        readdir(rootPath, { withFileTypes: true }),
      ]);
      // Hosts may hide dotfiles from their listings, so compare only the
      // entries both sides are certain to report.
      const visible = (name: string) => !name.startsWith(".");
      const localEntries = new Set(
        local
          .filter((entry) => visible(entry.name))
          .map((entry) => `${entry.isDirectory() ? "d" : "f"}:${entry.name}`),
      );
      const remoteEntries = remote.entries.filter((entry) =>
        visible(entry.name),
      );
      const matches =
        remoteEntries.length === localEntries.size &&
        remoteEntries.every((entry) =>
          localEntries.has(
            `${entry.kind === "directory" ? "d" : "f"}:${entry.name}`,
          ),
        );
      bb.log.debug(
        `Local index ${matches ? "enabled" : "disabled"} for ${rootPath} (host ${remoteEntries.length} vs local ${localEntries.size} entries)`,
      );
      return matches;
    } catch (error) {
      bb.log.debug(
        `Local index probe failed for ${rootPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  })();
  localRootProbes.set(key, {
    expiresAt: now + LOCAL_ROOT_PROBE_TTL_MS,
    promise,
  });
  return promise;
}

const REFRESH_MEMO_LIMIT = 256;
const refreshMemo = new Map<
  string,
  { mtimeMs: number; size: number; sha256: string }
>();

/**
 * The sha of a note the open-note poll already hashed, if nothing has touched
 * it on disk since. Lets the poll answer "unchanged" from a stat rather than a
 * host read every 500ms, which is what was saturating the file channel.
 */
async function unchangedNoteSha(
  bb: BbPluginApi,
  context: OpenContext,
): Promise<string | null> {
  if (!(await hostRootIsLocal(bb, context.hostId, context.rootPath))) return null;
  const memoized = refreshMemo.get(`${context.hostId}\0${context.absolutePath}`);
  if (!memoized) return null;
  try {
    const stats = await stat(context.absolutePath);
    return stats.mtimeMs === memoized.mtimeMs && stats.size === memoized.size
      ? memoized.sha256
      : null;
  } catch {
    return null;
  }
}

/**
 * Records a sha against the note's current stat. `sizeBytes` is the size of
 * the bytes that sha was computed from; when the file on disk is already a
 * different size (another writer landed between the host call and this stat)
 * nothing is memoized, so the next poll hashes the file again.
 */
async function rememberNoteSha(
  bb: BbPluginApi,
  context: OpenContext,
  sha256: string,
  sizeBytes?: number,
  stats?: { mtimeMs: number; size: number },
): Promise<void> {
  if (!(await hostRootIsLocal(bb, context.hostId, context.rootPath))) return;
  try {
    const current = stats ?? (await stat(context.absolutePath));
    if (sizeBytes !== undefined && current.size !== sizeBytes) return;
    const key = `${context.hostId}\0${context.absolutePath}`;
    refreshMemo.delete(key);
    refreshMemo.set(key, {
      mtimeMs: current.mtimeMs,
      size: current.size,
      sha256,
    });
    if (refreshMemo.size > REFRESH_MEMO_LIMIT) {
      refreshMemo.delete(refreshMemo.keys().next().value!);
    }
  } catch {
    // A note we cannot stat simply keeps going through the host.
  }
}

/**
 * The host reports `sha256` as the lowercase hex digest of the file's raw
 * bytes (verified against `bb file read --json`); hashing locally the same
 * way keeps the poll's compare-and-swap shas interchangeable with the host's.
 */
function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads and hashes a note straight from disk when the vault is local, so the
 * open-note poll does not wait on the host's file channel. Returns null when
 * the host must be asked instead. The memo is only updated when the file did
 * not change underneath the read.
 */
async function readLocalNote(
  bb: BbPluginApi,
  context: OpenContext,
): Promise<{ content: string; sha256: string } | null> {
  if (!(await hostRootIsLocal(bb, context.hostId, context.rootPath))) return null;
  try {
    const before = await stat(context.absolutePath);
    if (before.isDirectory()) return null;
    const bytes = await readFile(context.absolutePath);
    const after = await stat(context.absolutePath);
    const sha256 = sha256Hex(bytes);
    if (before.mtimeMs === after.mtimeMs && before.size === after.size) {
      void rememberNoteSha(bb, context, sha256, bytes.length, after);
    }
    return { content: bytes.toString("utf8"), sha256 };
  } catch {
    // Missing or unreadable here; the host may still see it.
    return null;
  }
}

/** Every linkable note under `rootPath`, or null if the walk cannot complete. */
async function walkLinkablePaths(rootPath: string): Promise<string[] | null> {
  const paths: string[] = [];
  // Symlinked directories report `isDirectory() === false` here, so the walk
  // cannot follow a link back into an ancestor and loop.
  const visit = async (directory: string, base: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const subdirectories: Array<[string, string]> = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relativePath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        subdirectories.push([path.join(directory, entry.name), relativePath]);
      } else if (LINKABLE_FILE_PATTERN.test(entry.name)) {
        if (paths.length >= LOCAL_WALK_MAX_ENTRIES) {
          throw new RangeError("Vault is too large to index locally");
        }
        paths.push(relativePath);
      }
    }
    await Promise.all(
      subdirectories.map(([child, childBase]) => visit(child, childBase)),
    );
  };
  try {
    await visit(rootPath, "");
    return paths;
  } catch {
    return null;
  }
}

async function listLinkablePaths(
  bb: BbPluginApi,
  hostId: string,
  rootPath: string,
  query?: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  // A truncated index sends every unresolved reference off to its own host
  // search, so prefer the local walk: it is both faster and complete.
  if (!query && (await hostRootIsLocal(bb, hostId, rootPath))) {
    const walked = await walkLinkablePaths(rootPath);
    if (walked) return { paths: walked, truncated: false };
  }
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
          entry.kind === "file" && LINKABLE_FILE_PATTERN.test(entry.path),
      )
      .map((entry) => entry.path.replace(/\\/g, "/")),
    truncated: index.truncated,
  };
}

// Share targeted searches across previews, including requests still in flight.
const targetedIndexes = new WeakMap<BbPluginApi, Map<string, {
  expiresAt: number;
  promise: Promise<{ paths: string[]; truncated: boolean }>;
}>>();

function targetedLinkablePaths(bb: BbPluginApi, context: OpenContext, reference: string) {
  let cache = targetedIndexes.get(bb);
  if (!cache) targetedIndexes.set(bb, cache = new Map());
  const query = wikilinkSearchQuery(reference);
  const key = `${context.hostId}\0${context.rootPath}\0${query}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: listLinkablePaths(bb, context.hostId, context.rootPath, query),
  };
  cache.set(key, entry);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  entry.promise.then(
    () => { entry.expiresAt = Date.now() + AUTOCOMPLETE_CACHE_TTL_MS; },
    () => { if (cache!.get(key) === entry) cache!.delete(key); },
  );
  return entry.promise;
}

function isExactWikilinkMatch(reference: string, currentPath: string, resolvedPath: string) {
  const requested = wikilinkSearchQuery(reference).replace(/\\/g, "/");
  if (!requested) return true;
  const withExtension = (value: string) => /\.(?:md|markdown|tldraw)$/i.test(value) ? value : `${value}.md`;
  const direct = withExtension(path.posix.normalize(requested.replace(/^\/+/, "")).replace(/^(?:\.\.\/)+/, ""));
  const relative = withExtension(path.posix.normalize(path.posix.join(path.posix.dirname(currentPath), requested)));
  const actual = resolvedPath.toLocaleLowerCase();
  return actual === direct.toLocaleLowerCase() || actual === relative.toLocaleLowerCase();
}

function wikilinkSearchQuery(reference: string): string {
  return normalizeWikilinkReference(reference).split("#", 1)[0]!.trim();
}

interface ReferenceScope {
  threadId?: string | undefined;
  source?: OpenerSource | undefined;
  path?: string | undefined;
}

// Wikilinks typed in a chat composer resolve against the thread's workspace;
// wikilinks typed inside an open note resolve against that note's workspace.
async function resolveReferenceContext(
  bb: BbPluginApi,
  scope: ReferenceScope,
): Promise<OpenContext | null> {
  if (scope.threadId) return resolveThreadContext(bb, scope.threadId);
  if (scope.source && typeof scope.path === "string") {
    try {
      return await resolveOpenContext(bb, scope.source, scope.path);
    } catch {
      return null;
    }
  }
  return null;
}

async function resolveChatWikilink(
  bb: BbPluginApi,
  scope: ReferenceScope,
  reference: string,
): Promise<{ target: LiveFileTarget | null; exists: boolean }> {
  const context = await resolveReferenceContext(bb, scope);
  if (!context) return { target: null, exists: false };
  const localPath = decodeLocalMarkdownPath(reference);
  if (localPath) {
    const resolved = await resolveLocalMarkdownLink(bb, localPath, context);
    return { target: resolved.target, exists: resolved.exists };
  }
  const cached = autocompleteIndexCache.get(`${context.hostId}\0${context.rootPath}`);
  let index = cached ? await cachedAutocompleteIndex(bb, context) : null;
  const known = index && resolveWikilinkPath(reference, context.currentRelativePath, index.paths);
  if (!index || (index.truncated && (!known?.exists || !isExactWikilinkMatch(reference, context.currentRelativePath, known.path)))) {
    index = await targetedLinkablePaths(bb, context, reference);
  }
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
  scope: ReferenceScope,
  query: string,
) {
  const normalizedQuery = query.trim();
  const context = await resolveReferenceContext(bb, scope);
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
  // Reading straight off disk skips a host round trip per hovered note.
  if (await hostRootIsLocal(bb, hostId, rootPath)) {
    try {
      return await readFile(absolutePath, "utf8");
    } catch {
      // Fall through to the host, which may see a file this process cannot.
    }
  }
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
  // Canvas archives are the largest previews; base64-ing them over the host
  // RPC is pure waste when the file is right here on disk.
  if (await hostRootIsLocal(bb, hostId, rootPath)) {
    try {
      return await readFile(absolutePath);
    } catch {
      // Fall through to the host, which may see a file this process cannot.
    }
  }
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
  return readUtf8File(bb, context.hostId, absolutePath, context.rootPath);
}

async function buildBacklinkIndex(
  bb: BbPluginApi,
  context: OpenContext,
  availablePaths: readonly string[],
) {
  const markdownPaths = availablePaths.filter((filePath) =>
    /\.(?:md|markdown)$/i.test(filePath),
  );
  const resolvePath = cachedWikilinkPathResolver(availablePaths);
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

type BacklinkIndex = Awaited<ReturnType<typeof buildBacklinkIndex>>;

/**
 * The backlink index costs a read of every note in the vault, so a stale one is
 * served immediately while the replacement builds in the background. Edits mark
 * it stale rather than dropping it, which keeps the hover after a save instant.
 */
function backlinkIndex(
  bb: BbPluginApi,
  context: OpenContext,
  cacheKey: string,
): Promise<BacklinkIndex> {
  const now = Date.now();
  const cached = backlinkIndexCache.get(cacheKey);
  const build = () =>
    cachedAutocompleteIndex(bb, context).then((index) =>
      buildBacklinkIndex(bb, context, index.paths),
    );
  if (cached) {
    if (cached.expiresAt <= now) {
      // Hold off other refreshes while this one is in flight.
      cached.expiresAt = now + BACKLINK_INDEX_TTL_MS;
      build().then(
        (fresh) =>
          backlinkIndexCache.set(cacheKey, {
            expiresAt: Date.now() + BACKLINK_INDEX_TTL_MS,
            promise: Promise.resolve(fresh),
          }),
        () => {
          cached.expiresAt = Date.now() + BACKLINK_INDEX_TTL_MS;
        },
      );
    }
    return cached.promise;
  }
  const promise = build();
  backlinkIndexCache.set(cacheKey, {
    expiresAt: now + BACKLINK_INDEX_TTL_MS,
    promise,
  });
  promise.catch(() => backlinkIndexCache.delete(cacheKey));
  return promise;
}

/** Marks the vault's backlink index for a background rebuild. */
function expireBacklinkIndex(cacheKey: string): void {
  const cached = backlinkIndexCache.get(cacheKey);
  if (cached) cached.expiresAt = 0;
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
  const index = await backlinkIndex(bb, context, cacheKey);
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
    const body = stripYamlFrontmatter(content).trimStart();
    return {
      content: body,
      truncated: false,
      imageDataUrl: null,
      backlinks: null,
      links: await resolveLinks(bb, body, context, index),
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
    const environment = await cachedEnvironment(bb, target.environmentId);
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
    const storage = await cachedThreadStorage(bb, target.threadId);
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
  const resolveIndexedPath = cachedWikilinkPathResolver(index.paths);
  const wikilinks = extractWikilinkReferences(content).map(
    async (reference) => {
      let availablePaths = index.paths;
      const indexedPath = resolveIndexedPath(reference, context.currentRelativePath);
      if (index.truncated && (!indexedPath || !isExactWikilinkMatch(reference, context.currentRelativePath, indexedPath))) {
        const targetedIndex = await targetedLinkablePaths(bb, context, reference);
        availablePaths = [...targetedIndex.paths, ...index.paths];
      }
      const resolved =
        availablePaths === index.paths
          ? indexedPath
            ? { path: indexedPath, exists: true }
            : // The index is complete here, so the miss is final: no rescan.
              {
                path: wikilinkFallbackPath(reference, context.currentRelativePath),
                exists: false,
              }
          : resolveWikilinkPath(reference, context.currentRelativePath, availablePaths);
      return {
        reference,
        target: context.targetFor(resolved.path),
        exists: resolved.exists,
      };
    },
  );
  const markdownLinks = resolveLocalMarkdownLinks(
    bb,
    extractLocalMarkdownPaths(content),
    context,
  );
  const [resolvedWikilinks, resolvedMarkdownLinks] = await Promise.all([
    Promise.all(wikilinks),
    markdownLinks,
  ]);
  const resolved = [...resolvedWikilinks, ...resolvedMarkdownLinks];
  return [...new Map(resolved.map((link) => [link.reference, link])).values()];
}

async function resolveOpenContext(
  bb: BbPluginApi,
  source: OpenerSource,
  filePath: string,
): Promise<OpenContext> {
  if (source.kind === "workspace" && source.environmentId) {
    const environment = await cachedEnvironment(bb, source.environmentId);
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
    const storage = await cachedThreadStorage(bb, source.threadId);
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

  throw new Error("This Markdown source cannot be opened by Wikilinks");
}

export default async function plugin(bb: BbPluginApi) {
  const threadContextCache = new Map<string, { expires: number; promise: ReturnType<typeof loadThreadMessages> }>();
  bb.onDispose(() => threadContextCache.clear());
  const mediaTickets = new Map<string, { url: string; expiresAtMs: number }>();
  for (const method of ["GET", "HEAD"]) bb.http.route(method, "/media", async (c) => {
    const ticket = mediaTickets.get(c.req.query("key") ?? "");
    if (!ticket || ticket.expiresAtMs <= Date.now()) return new Response("Attachment link expired", { status: 404 });
    const upstream = await fetch(new URL(ticket.url, bb.server.loopbackBaseUrl), { signal: c.req.raw.signal });
    return mediaResponse(c.req.raw, upstream);
  });
  bb.onDispose(() => mediaTickets.clear());
  autocompleteIndexCache.clear();
  backlinkIndexCache.clear();
  webPreviewCache.clear();
  localRootProbes.clear();
  refreshMemo.clear();
  environmentCache.clear();
  threadStorageCache.clear();
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
    async open_markdown({ path: filePath, source, createIfMissing }) {
      const context = await resolveOpenContext(bb, source, filePath);
      const args = {
        hostId: context.hostId,
        path: context.absolutePath,
        rootPath: context.rootPath,
      };
      let created = false;
      let file;
      try {
        file = await bb.sdk.files.read(args);
      } catch (error) {
        if (!createIfMissing || !/\.(md|markdown)$/i.test(filePath)) throw error;
        const { existence } = await bb.sdk.hosts.pathsExist({
          hostId: context.hostId,
          paths: [context.absolutePath],
        });
        if (existence[context.absolutePath] !== false) throw error;
        const written = await bb.sdk.files.write({
          ...args,
          content: "",
          contentEncoding: "utf8",
          createParents: true,
          expectedSha256: null,
        });
        created = written.outcome === "written";
        autocompleteIndexCache.delete(`${context.hostId}\0${context.rootPath}`);
        expireBacklinkIndex(`${context.hostId}\0${context.rootPath}`);
        file = await bb.sdk.files.read(args);
      }
      void rememberNoteSha(bb, context, file.sha256, file.sizeBytes);
      return {
        content: file.contentEncoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf8")
          : file.content,
        sha256: file.sha256,
        ...(created ? { created: true } : {}),
      };
    },
    async refresh_markdown({ path: filePath, source, knownSha256 }) {
      const controller = new AbortController();
      const startedAt = Date.now();
      let stage = "resolve context";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Markdown refresh timed out during ${stage}`);
          reject(error);
          controller.abort(error);
        }, 5_000);
      });
      type RefreshRead =
        | { unchangedSha: string; context: OpenContext }
        | { local: { content: string; sha256: string }; context: OpenContext }
        | { file: Awaited<ReturnType<typeof bb.sdk.files.read>>; context: OpenContext };
      const read = async (): Promise<RefreshRead> => {
        const context = await resolveOpenContext(bb, source, filePath);
        controller.signal.throwIfAborted();
        stage = "read file";
        const unchangedSha = await unchangedNoteSha(bb, context);
        if (unchangedSha !== null) return { unchangedSha, context };
        const local = await readLocalNote(bb, context);
        if (local) return { local, context };
        controller.signal.throwIfAborted();
        const file = await bb.sdk.files.read({
          hostId: context.hostId,
          path: context.absolutePath,
          rootPath: context.rootPath,
          signal: controller.signal,
        });
        return { file, context };
      };
      let result;
      try {
        result = await Promise.race([read(), deadline]);
      } catch (error) {
        bb.log.warn(
          `Markdown refresh failed (${stage}, ${Date.now() - startedAt}ms): ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if ("unchangedSha" in result) {
        return { changed: false as const, sha256: result.unchangedSha };
      }
      if ("local" in result) {
        const { local } = result;
        return local.sha256 === knownSha256
          ? { changed: false as const, sha256: local.sha256 }
          : { changed: true as const, content: local.content, sha256: local.sha256 };
      }
      const { file, context } = result;
      void rememberNoteSha(bb, context, file.sha256, file.sizeBytes);
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
    async resolve_media({ path: filePath, source, reference }) {
      if (!mediaKind(reference)) throw new Error("Unsupported attachment type");
      const context = await resolveOpenContext(bb, source, filePath);
      const requested = reference.split("#", 1)[0]!.trim().replace(/\\/g, "/");
      if (isAbsoluteHostPath(requested) || /^[a-z][a-z0-9+.-]*:/i.test(requested)) throw new Error("Attachments must be within the note workspace");
      const candidates = [...new Set([
        path.posix.join(path.posix.dirname(context.currentRelativePath), requested), path.posix.normalize(requested),
      ])].filter(p => p !== ".." && !p.startsWith("../") && !path.posix.isAbsolute(p));
      const { existence } = await bb.sdk.hosts.pathsExist({ hostId: context.hostId, paths: candidates.map(p => joinHostPath(context.rootPath, p)) });
      let found = candidates.find(p => existence[joinHostPath(context.rootPath, p)]);
      if (!found && !requested.includes("/")) {
        const listing = await bb.sdk.files.listPaths({ hostId: context.hostId, path: context.rootPath, query: requested, limit: 1000, includeFiles: true, includeDirectories: false });
        found = listing.paths.map(p => p.path).filter(p => !p.startsWith("../") && !path.posix.isAbsolute(p) && path.posix.basename(p).toLocaleLowerCase() === requested.toLocaleLowerCase()).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
      }
      if (!found) return { url: null, expiresAtMs: 0 };
      const preview = await bb.sdk.files.createPreview({ hostId: context.hostId, rootPath: joinHostPath(context.rootPath, path.posix.dirname(found)), ttlMs: 60 * 60_000 });
      const url = `${preview.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(path.posix.basename(found))}`;
      if (mediaKind(reference) === "image") return { url, expiresAtMs: preview.expiresAtMs };
      for (const [key, ticket] of mediaTickets) if (ticket.expiresAtMs <= Date.now()) mediaTickets.delete(key);
      if (mediaTickets.size >= 4096) mediaTickets.delete(mediaTickets.keys().next().value!);
      const key = randomUUID();
      mediaTickets.set(key, { url, expiresAtMs: preview.expiresAtMs });
      return { url: `/api/v1/plugins/wikilinks/http/media?key=${key}`, expiresAtMs: preview.expiresAtMs };
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
      expireBacklinkIndex(`${context.hostId}\0${context.rootPath}`);
      void rememberNoteSha(
        bb,
        context,
        result.sha256,
        Buffer.byteLength(content, "utf8"),
      );
      return {
        outcome: "written" as const,
        sha256: result.sha256,
      };
    },
    async resolve_chat_wikilink({ threadId, source, path, reference }) {
      return resolveChatWikilink(bb, { threadId, source, path }, reference);
    },
    async thread_backlink_context({ threadId, path: filePath, source }) {
      const context = await resolveOpenContext(bb, source, filePath);
      const index = await cachedAutocompleteIndex(bb, context);
      const resolver = cachedWikilinkPathResolver(index.paths);
      let cached = threadContextCache.get(threadId);
      if (!cached || cached.expires < Date.now()) {
        if (threadContextCache.size >= 32) threadContextCache.delete(threadContextCache.keys().next().value!);
        const promise = loadThreadMessages(bb, threadId);
        cached = { expires: Date.now() + 30_000, promise };
        threadContextCache.set(threadId, cached);
        promise.catch(() => { if (threadContextCache.get(threadId)?.promise === promise) threadContextCache.delete(threadId); });
      }
      const loaded = await cached.promise;
      const result = extractThreadBacklinks(loaded.messages, reference => {
        const relative = reference.startsWith(`${context.rootPath}/`) ? reference.slice(context.rootPath.length + 1) : reference;
        return resolver(relative, "")?.toLocaleLowerCase() === context.currentRelativePath.toLocaleLowerCase();
      });
      return {
        ...result,
        truncated: loaded.truncated || result.truncated,
        links: await resolveLinks(bb, result.occurrences.map(item => item.preview).join("\n"), { ...context, currentRelativePath: "" }, index),
      };
    },
    async preview_file({ target, backlinks }) {
      return previewFile(bb, target, backlinks);
    },
    async preview_url({ url }) {
      return cachedWebPreview(url);
    },
    async preview_chat_wikilink({
      threadId,
      source,
      path,
      reference,
      backlinks,
    }) {
      const resolved = await resolveChatWikilink(
        bb,
        { threadId, source, path },
        reference,
      );
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
    async autocomplete_wikilinks({ threadId, source, path, query }) {
      return autocompleteWikilinks(bb, { threadId, source, path }, query);
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
    skills: ["wikilinks"],
    instructions:
      "Thinking trails record note paths the user explored. Hover indicates curiosity; a clicked step is a stronger attention signal. Query them when reconstructing prior working context would help. When writing aliased wikilinks inside Markdown table cells, escape the alias pipe with one backslash: [[Note title\|Display text]]. Outside tables use [[Note title|Display text]].",
  }));
}
