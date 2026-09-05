import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createMarkdownExcerpt } from "./preview-markdown.js";

const MAX_RESPONSE_BYTES = 1_500_000;
const WEB_PREVIEW_LENGTH = 6_000;
const WEB_PREVIEW_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;

export interface WebPreviewResult {
  url: string;
  title: string;
  siteName: string;
  content: string;
  format: "markdown" | "text";
  truncated: boolean;
}

interface Address {
  address: string;
  family: number;
}

interface WebPreviewDependencies {
  fetcher?: typeof fetch;
  resolveAddresses?: (hostname: string) => Promise<Address[]>;
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    ((parts[0]! << 24) >>> 0) +
    (parts[1]! << 16) +
    (parts[2]! << 8) +
    parts[3]!
  );
}

function inIpv4Range(address: number, network: string, prefix: number): boolean {
  const networkNumber = ipv4Number(network)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (networkNumber & mask);
}

export function isPrivateNetworkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address)!;
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
    ].some(([network, prefix]) =>
      inIpv4Range(value, network as string, prefix as number),
    );
  }
  if (version !== 6) return true;
  const value = address.toLocaleLowerCase();
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateNetworkAddress(mapped) : true;
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:")
  );
}

async function defaultResolveAddresses(hostname: string): Promise<Address[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function validatedWebUrl(
  rawUrl: string,
  resolveAddresses: (hostname: string) => Promise<Address[]>,
): Promise<URL> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS links can be previewed");
  }
  if (url.username || url.password) {
    throw new Error("Authenticated URLs cannot be previewed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Local network links cannot be previewed");
  }
  const directVersion = isIP(hostname);
  const addresses = directVersion
    ? [{ address: hostname, family: directVersion }]
    : await resolveAddresses(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateNetworkAddress(address))
  ) {
    throw new Error("Private network links cannot be previewed");
  }
  return url;
}

async function readBoundedText(response: Response): Promise<{
  text: string;
  truncated: boolean;
}> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_RESPONSE_BYTES - size;
    if (next.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: new TextDecoder().decode(bytes), truncated };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    nbsp: " ",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
    lt: "<",
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi,
    (entity, code: string) => {
      if (code[0] !== "#") return named[code.toLocaleLowerCase()] ?? entity;
      const hexadecimal = code[1]?.toLocaleLowerCase() === "x";
      const number = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    },
  );
}

function plainHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, names: string[]): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(
      /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    )) {
      attributes.set(
        match[1]!.toLocaleLowerCase(),
        match[2] ?? match[3] ?? match[4] ?? "",
      );
    }
    const key = (
      attributes.get("property") ?? attributes.get("name") ?? ""
    ).toLocaleLowerCase();
    if (names.includes(key)) return plainHtmlText(attributes.get("content") ?? "");
  }
  return "";
}

function htmlBodyText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  return decodeHtmlEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg|noscript|template|nav|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(?:p|div|section|article|main|aside|header|h[1-6]|li|ul|ol|blockquote|pre)>/gi, "\n\n")
      .replace(/<[^>]*>/g, " "),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlPreview(html: string, url: URL, responseTruncated: boolean): WebPreviewResult {
  const title =
    metaContent(html, ["og:title", "twitter:title"]) ||
    plainHtmlText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") ||
    url.hostname;
  const siteName = metaContent(html, ["og:site_name"]) || url.hostname;
  const description = metaContent(html, [
    "description",
    "og:description",
    "twitter:description",
  ]);
  const body = htmlBodyText(html);
  const combined = [description, body]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("\n\n");
  const excerpt = createMarkdownExcerpt(combined || title, WEB_PREVIEW_LENGTH);
  return {
    url: url.href,
    title,
    siteName,
    content: excerpt.content,
    format: "text",
    truncated: responseTruncated || excerpt.truncated,
  };
}

export async function fetchWebPreview(
  rawUrl: string,
  dependencies: WebPreviewDependencies = {},
): Promise<WebPreviewResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const resolveAddresses =
    dependencies.resolveAddresses ?? defaultResolveAddresses;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_PREVIEW_TIMEOUT_MS);
  try {
    let url = await validatedWebUrl(rawUrl, resolveAddresses);
    let response: Response | null = null;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      response = await fetcher(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept:
            "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.1",
          "user-agent": "BB-Wikilinks-Preview/0.1",
        },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new Error("Too many redirects while previewing this link");
      }
      url = await validatedWebUrl(new URL(location, url).href, resolveAddresses);
    }
    if (!response?.ok) {
      throw new Error(`Web preview request failed (${response?.status ?? "unknown"})`);
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLocaleLowerCase();
    if (
      contentType &&
      !contentType.startsWith("text/") &&
      contentType !== "application/xhtml+xml"
    ) {
      throw new Error("This link does not contain previewable text");
    }
    const body = await readBoundedText(response);
    const markdown =
      contentType === "text/markdown" ||
      contentType === "text/x-markdown" ||
      /\.(?:md|markdown)$/i.test(url.pathname);
    if (markdown) {
      const excerpt = createMarkdownExcerpt(body.text, WEB_PREVIEW_LENGTH);
      return {
        url: url.href,
        title:
          /^#\s+(.+)$/m.exec(excerpt.content)?.[1]?.trim() ||
          decodeURIComponent(url.pathname.split("/").at(-1) ?? url.hostname),
        siteName: url.hostname,
        content: excerpt.content,
        format: "markdown",
        truncated: body.truncated || excerpt.truncated,
      };
    }
    if (contentType === "text/html" || contentType === "application/xhtml+xml" || /<html\b/i.test(body.text)) {
      return htmlPreview(body.text, url, body.truncated);
    }
    const excerpt = createMarkdownExcerpt(body.text, WEB_PREVIEW_LENGTH);
    return {
      url: url.href,
      title: decodeURIComponent(url.pathname.split("/").at(-1) || url.hostname),
      siteName: url.hostname,
      content: excerpt.content,
      format: "text",
      truncated: body.truncated || excerpt.truncated,
    };
  } finally {
    clearTimeout(timeout);
  }
}
