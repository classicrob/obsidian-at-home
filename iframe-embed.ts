/**
 * Raw `<iframe>` embeds in notes (YouTube, Loom, Figma, …), the way Obsidian
 * renders them. Only iframes are honoured, never arbitrary HTML: each tag is
 * parsed into attributes, its src is checked against a host allowlist, and a
 * fresh, sandboxed iframe is built from the src alone. Anything else falls
 * back to a plain link.
 */

/** Hosts (and their subdomains) whose iframes render as live embeds. */
export const IFRAME_HOST_ALLOWLIST = [
  "youtube.com",
  "youtube-nocookie.com",
  "vimeo.com",
  "loom.com",
  "figma.com",
  "bcast.fm",
  "raindrop.io",
] as const;

export const IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";
export const IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; web-share";

export type IframeEmbed =
  | {
      kind: "embed";
      src: string;
      title: string;
      /** width / height, when the frame keeps an aspect ratio. */
      aspectRatio: number | null;
      /** Fixed CSS pixel height, for full-width players like podcasts. */
      height: number | null;
      /** Authored pixel width, used as a max-width on wide screens. */
      maxWidth: number | null;
    }
  | { kind: "link"; href: string; title: string }
  | { kind: "text"; text: string };

const IFRAME_TAG = /<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE =
  /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

/** True when `html` contains at least one iframe opening tag. */
export function containsIframe(html: string): boolean {
  return /<iframe\b/i.test(html);
}

export function isAllowedIframeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return IFRAME_HOST_ALLOWLIST.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function pixels(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

function styleProperty(style: string | undefined, property: string): string | undefined {
  if (!style) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(style);
  return match?.[1]?.trim();
}

function sanitize(attributes: Map<string, string>, wrapperAspect: number | null): IframeEmbed | null {
  const rawSrc = attributes.get("src")?.trim() ?? "";
  if (!rawSrc) return null;
  const title = attributes.get("title")?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(rawSrc);
  } catch {
    return { kind: "text", text: rawSrc };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "text", text: rawSrc };
  }
  if (url.protocol !== "https:" || url.username || url.password || !isAllowedIframeHost(url.hostname)) {
    return { kind: "link", href: url.href, title };
  }
  const style = attributes.get("style");
  const width = pixels(attributes.get("width")) ?? pixels(styleProperty(style, "width"));
  const height = pixels(styleProperty(style, "height")) ?? pixels(attributes.get("height"));
  const aspectRatio = width && height ? width / height : height ? null : (wrapperAspect ?? 16 / 9);
  return {
    kind: "embed",
    src: url.href,
    title: title || url.hostname.replace(/^www\./, ""),
    aspectRatio,
    height: aspectRatio === null ? height : null,
    maxWidth: aspectRatio !== null ? width : null,
  };
}

/**
 * Every iframe in a chunk of raw HTML, sanitized. A responsive wrapper such
 * as Loom's `<div style="padding-bottom: 67.6%">` supplies the aspect ratio
 * for a frame that has no width or height of its own.
 */
export function parseIframeEmbeds(html: string): IframeEmbed[] {
  const padding = /padding-bottom\s*:\s*(\d+(?:\.\d+)?)%/i.exec(html);
  const wrapperAspect = padding && Number(padding[1]) > 0 ? 100 / Number(padding[1]) : null;
  const embeds: IframeEmbed[] = [];
  for (const match of html.matchAll(IFRAME_TAG)) {
    const embed = sanitize(parseAttributes(match[1] ?? ""), wrapperAspect);
    if (embed) embeds.push(embed);
  }
  return embeds;
}

/** Link text for an embed that is shown as a link instead. */
export function iframeLinkLabel(embed: { href: string; title: string }): string {
  if (embed.title) return embed.title;
  try {
    const url = new URL(embed.href);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return embed.href;
  }
}

/** Inline style for the sizing wrapper of an allowed embed. */
export function iframeFrameStyle(embed: Extract<IframeEmbed, { kind: "embed" }>): Record<string, string> {
  if (embed.aspectRatio !== null) {
    return {
      aspectRatio: String(embed.aspectRatio),
      ...(embed.maxWidth ? { maxWidth: `${embed.maxWidth}px` } : {}),
    };
  }
  return { height: `${embed.height ?? 150}px` };
}

/**
 * Builds DOM for embeds, for contexts outside React (the Tiptap node view).
 * Fallback links get `href` only; the editor's click handler opens them.
 */
export function renderIframeEmbedsDOM(html: string, inline: boolean): HTMLElement {
  const container = document.createElement(inline ? "span" : "div");
  container.className = inline ? "wikilinks-iframe-group is-inline" : "wikilinks-iframe-group";
  for (const embed of parseIframeEmbeds(html)) {
    if (embed.kind === "embed") {
      const frame = document.createElement(inline ? "span" : "div");
      frame.className = "wikilinks-iframe-embed";
      Object.assign(frame.style, iframeFrameStyle(embed));
      const iframe = document.createElement("iframe");
      iframe.src = embed.src;
      iframe.title = embed.title;
      iframe.setAttribute("sandbox", IFRAME_SANDBOX);
      iframe.setAttribute("allow", IFRAME_ALLOW);
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute("loading", "lazy");
      iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.append(iframe);
      container.append(frame);
    } else if (embed.kind === "link") {
      const link = document.createElement("a");
      link.href = embed.href;
      link.className = "wikilinks-iframe-link";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = iframeLinkLabel(embed);
      container.append(link);
    } else {
      const text = document.createElement("code");
      text.className = "wikilinks-iframe-link";
      text.textContent = embed.text;
      container.append(text);
    }
  }
  return container;
}
