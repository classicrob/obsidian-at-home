import {
  decodeLocalMarkdownPath,
  displayWikilinkLabel,
} from "./wikilink-markdown.js";
import { elementRect, type HoverAnchorRect } from "./hover-types.js";

export const CHAT_WIKILINK_OPEN_EVENT = "bb:wikilinks:open";
export const CHAT_WIKILINK_HOVER_EVENT = "bb:wikilinks:hover";
export const CHAT_WIKILINK_LEAVE_EVENT = "bb:wikilinks:leave";

export interface ChatWikilinkOpenDetail {
  bridgeId: string;
  reference: string;
}

export interface ChatWikilinkHoverDetail extends ChatWikilinkOpenDetail {
  anchor: HoverAnchorRect;
  immediate?: boolean;
  backlinks?: boolean;
  web?: boolean;
}

const SKIPPED_ANCESTORS =
  'a, code, pre, kbd, samp, textarea, [contenteditable="true"]';
const SKIPPED_LINK_ANCESTORS =
  'code, pre, kbd, samp, textarea, [contenteditable="true"]';

interface OriginalAnchorState {
  className: string | null;
  title: string | null;
  reference: string | null;
  kind: string | null;
}

function normalizedWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function isChatMarkdownText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIPPED_ANCESTORS)) return false;
  const markdown = parent.closest("[data-markdown-preview]");
  return Boolean(
    markdown?.closest(
      "[data-thread-window][data-wikilinks-bridge-id]",
    ),
  );
}

function acceptedMatches(value: string): RegExpMatchArray[] {
  const matches: RegExpMatchArray[] = [];
  for (const match of value.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index!;
    if (start > 0 && value[start - 1] === "!") continue;
    if (match[1]!.split("|", 1)[0]!.trim() === "") continue;
    matches.push(match);
  }
  return matches;
}

function decorateTextNode(
  node: Text,
  ownedLinks: Set<HTMLAnchorElement>,
): number {
  const value = node.nodeValue ?? "";
  if (!value.includes("[[") || !isChatMarkdownText(node)) return 0;
  const matches = acceptedMatches(value);
  if (matches.length === 0) return 0;

  const fragment = node.ownerDocument.createDocumentFragment();
  let cursor = 0;
  for (const match of matches) {
    const start = match.index!;
    if (start > cursor) {
      fragment.append(value.slice(cursor, start));
    }
    const raw = match[1]!;
    const [rawReference, rawAlias] = raw.split("|", 2);
    const reference = rawReference!.trim();
    const link = node.ownerDocument.createElement("a");
    link.className = "wikilink wikilink-chat";
    link.href = `./${encodeURIComponent(reference)}`;
    link.dataset.wikilinkReference = reference;
    link.dataset.wikilinkSource = match[0];
    link.title = `Open ${reference}`;
    link.textContent = displayWikilinkLabel(reference, rawAlias);
    ownedLinks.add(link);
    fragment.append(link);
    cursor = start + match[0].length;
  }
  if (cursor < value.length) fragment.append(value.slice(cursor));
  node.replaceWith(fragment);
  return matches.length;
}

function decorateMarkdownAnchor(
  link: HTMLAnchorElement,
  decoratedLinks: Map<HTMLAnchorElement, OriginalAnchorState>,
): number {
  if (
    decoratedLinks.has(link) ||
    link.dataset.wikilinkReference ||
    link.closest(SKIPPED_LINK_ANCESTORS)
  ) {
    return 0;
  }
  const markdown = link.closest("[data-markdown-preview]");
  if (
    !markdown?.closest("[data-thread-window][data-wikilinks-bridge-id]")
  ) {
    return 0;
  }
  const href = link.getAttribute("href") ?? "";
  const localReference = decodeLocalMarkdownPath(href);
  const webUrl = localReference ? null : normalizedWebUrl(href);
  const reference = localReference ?? webUrl;
  if (!reference) return 0;

  decoratedLinks.set(link, {
    className: link.getAttribute("class"),
    title: link.getAttribute("title"),
    reference: link.getAttribute("data-wikilink-reference"),
    kind: link.getAttribute("data-wikilink-kind"),
  });
  link.classList.add(
    webUrl ? "wikilink-standard" : "wikilink",
    "wikilink-chat",
  );
  link.dataset.wikilinkReference = reference;
  if (webUrl) link.dataset.wikilinkKind = "web";
  link.title = webUrl ? `Preview ${new URL(webUrl).hostname}` : `Open ${reference}`;
  return 1;
}

export function decorateChatWikilinks(
  root: Node,
  ownedLinks: Set<HTMLAnchorElement> = new Set(),
  decoratedLinks: Map<HTMLAnchorElement, OriginalAnchorState> = new Map(),
): number {
  if (root instanceof Text) return decorateTextNode(root, ownedLinks);
  if (!root.isConnected && root !== document) return 0;
  const anchors = [
    ...(root instanceof HTMLAnchorElement ? [root] : []),
    ...(root instanceof Element || root instanceof Document
      ? Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
      : []),
  ];
  let count = anchors.reduce(
    (total, link) => total + decorateMarkdownAnchor(link, decoratedLinks),
    0,
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }
  count += textNodes.reduce(
    (count, node) => count + decorateTextNode(node, ownedLinks),
    0,
  );
  return count;
}

export function mountChatWikilinks(signal: AbortSignal): () => void {
  const ownedLinks = new Set<HTMLAnchorElement>();
  const decoratedLinks = new Map<HTMLAnchorElement, OriginalAnchorState>();
  const pending = new Set<Node>();
  let timer: number | null = null;
  let disposed = false;
  let activeHoverLink: HTMLAnchorElement | null = null;

  const flush = () => {
    timer = null;
    for (const node of pending) {
      if (node.isConnected) {
        decorateChatWikilinks(node, ownedLinks, decoratedLinks);
      }
    }
    pending.clear();
  };
  const schedule = (node: Node) => {
    pending.add(node);
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(flush, 120);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") schedule(record.target);
      if (record.type === "attributes") schedule(record.target);
      for (const node of Array.from(record.addedNodes)) schedule(node);
    }
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-wikilinks-bridge-id"],
    characterData: true,
    childList: true,
    subtree: true,
  });

  const onClick = (event: MouseEvent) => {
    const clicked = event.target instanceof Element ? event.target : null;
    const link = clicked?.closest<HTMLAnchorElement>(
      "a[data-wikilink-reference]",
    );
    if (!link) return;
    const threadWindow = link.closest<HTMLElement>(
      "[data-thread-window][data-wikilinks-bridge-id]",
    );
    const bridgeId = threadWindow?.dataset.wikilinksBridgeId;
    const reference = link.dataset.wikilinkReference;
    if (!bridgeId || !reference) return;
    if (link.dataset.wikilinkKind === "web") return;
    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    event.preventDefault();
    window.dispatchEvent(
      new CustomEvent<ChatWikilinkOpenDetail>(CHAT_WIKILINK_OPEN_EVENT, {
        detail: { bridgeId, reference },
      }),
    );
  };
  const linkFromTarget = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest<HTMLAnchorElement>("a.wikilink-chat[data-wikilink-reference]")
      : null;
  const detailForLink = (
    link: HTMLAnchorElement,
  ): (ChatWikilinkOpenDetail & { web?: boolean }) | null => {
    const bridgeId = link.closest<HTMLElement>(
      "[data-thread-window][data-wikilinks-bridge-id]",
    )?.dataset.wikilinksBridgeId;
    const reference = link.dataset.wikilinkReference;
    return bridgeId && reference
      ? {
          bridgeId,
          reference,
          ...(link.dataset.wikilinkKind === "web" ? { web: true } : {}),
        }
      : null;
  };
  const onPointerOver = (event: PointerEvent) => {
    const link = linkFromTarget(event.target);
    if (!link) return;
    if (event.relatedTarget instanceof Node && link.contains(event.relatedTarget)) {
      return;
    }
    const detail = detailForLink(link);
    if (!detail) return;
    activeHoverLink = link;
    window.dispatchEvent(
      new CustomEvent<ChatWikilinkHoverDetail>(CHAT_WIKILINK_HOVER_EVENT, {
        detail: {
          ...detail,
          anchor: elementRect(link),
          ...(event.metaKey ? { backlinks: true } : {}),
        },
      }),
    );
  };
  const onPointerOut = (event: PointerEvent) => {
    const link = linkFromTarget(event.target);
    if (!link) return;
    if (event.relatedTarget instanceof Node && link.contains(event.relatedTarget)) {
      return;
    }
    const detail = detailForLink(link);
    if (!detail) return;
    if (activeHoverLink === link) activeHoverLink = null;
    window.dispatchEvent(
      new CustomEvent<ChatWikilinkOpenDetail>(CHAT_WIKILINK_LEAVE_EVENT, {
        detail,
      }),
    );
  };
  const onFocusIn = (event: FocusEvent) => {
    const link = linkFromTarget(event.target);
    const detail = link ? detailForLink(link) : null;
    if (!link || !detail) return;
    activeHoverLink = link;
    window.dispatchEvent(
      new CustomEvent<ChatWikilinkHoverDetail>(CHAT_WIKILINK_HOVER_EVENT, {
        detail: { ...detail, anchor: elementRect(link), immediate: true },
      }),
    );
  };
  const onFocusOut = (event: FocusEvent) => {
    const link = linkFromTarget(event.target);
    const detail = link ? detailForLink(link) : null;
    if (!detail) return;
    if (activeHoverLink === link) activeHoverLink = null;
    window.dispatchEvent(
      new CustomEvent<ChatWikilinkOpenDetail>(CHAT_WIKILINK_LEAVE_EVENT, {
        detail,
      }),
    );
  };
  const onModifierChange = (event: KeyboardEvent) => {
    if (event.key !== "Meta" || !activeHoverLink) return;
    const detail = detailForLink(activeHoverLink);
    if (!detail) return;
    window.dispatchEvent(
      new CustomEvent<ChatWikilinkHoverDetail>(CHAT_WIKILINK_HOVER_EVENT, {
        detail: {
          ...detail,
          anchor: elementRect(activeHoverLink),
          immediate: true,
          ...(event.type === "keydown" && !detail.web
            ? { backlinks: true }
            : {}),
        },
      }),
    );
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  window.addEventListener("keydown", onModifierChange);
  window.addEventListener("keyup", onModifierChange);
  decorateChatWikilinks(document, ownedLinks, decoratedLinks);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("pointerover", onPointerOver, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    window.removeEventListener("keydown", onModifierChange);
    window.removeEventListener("keyup", onModifierChange);
    if (timer !== null) window.clearTimeout(timer);
    pending.clear();
    for (const link of ownedLinks) {
      if (link.isConnected) link.replaceWith(link.dataset.wikilinkSource ?? "");
    }
    ownedLinks.clear();
    for (const [link, original] of decoratedLinks) {
      const restore = (name: string, value: string | null) => {
        if (value === null) link.removeAttribute(name);
        else link.setAttribute(name, value);
      };
      restore("class", original.className);
      restore("title", original.title);
      restore("data-wikilink-reference", original.reference);
      restore("data-wikilink-kind", original.kind);
    }
    decoratedLinks.clear();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
