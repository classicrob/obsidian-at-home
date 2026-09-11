import {
  CHAT_WIKILINK_HOVER_EVENT,
  CHAT_WIKILINK_LEAVE_EVENT,
  CHAT_WIKILINK_OPEN_EVENT,
  type ChatWikilinkHoverDetail,
  type ChatWikilinkOpenDetail,
} from "./chat-wikilinks.js";
import { elementRect, type HoverAnchorRect } from "./hover-types.js";

export const COMPOSER_WIKILINK_QUERY_EVENT =
  "bb:wikilinks:composer-autocomplete-query";
export const COMPOSER_WIKILINK_RESULTS_EVENT =
  "bb:wikilinks:composer-autocomplete-results";

export interface ComposerWikilinkSuggestion {
  reference: string;
  label: string;
  directory: string;
}

export interface ComposerWikilinkQueryDetail {
  bridgeId: string;
  requestId: number;
  query: string;
}

export interface ComposerWikilinkResultsDetail {
  bridgeId: string;
  requestId: number;
  suggestions: ComposerWikilinkSuggestion[];
}

interface ActiveAutocomplete {
  editor: HTMLElement;
  host: HTMLElement;
  placement: "above" | "caret";
  bridgeId: string;
  query: string;
  requestId: number;
  replacementRange: Range;
  suggestions: ComposerWikilinkSuggestion[];
  selectedIndex: number;
}

interface ComposerTextLink {
  editor: HTMLElement;
  bridgeId: string;
  node: Text;
  start: number;
  end: number;
  reference: string;
}

const QUERY_DELAY_MS = 85;
const MAX_QUERY_LENGTH = 160;
const CARET_MENU_WIDTH_PX = 352;

// The chat composer (BB's promptbox) and the wikilinks live note editor both
// host the same autocomplete. The promptbox shows the menu above the box; the
// note editor shows it at the caret.
const EDITOR_CONTENT_SELECTOR =
  "[data-promptbox-editor-content], [data-wikilinks-autocomplete-host]";
const HOST_SELECTOR = "[data-promptbox], [data-wikilinks-autocomplete-host]";
const BLOCK_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, div";

function composerEditor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const content = target.closest<HTMLElement>(EDITOR_CONTENT_SELECTOR);
  if (!content) return null;
  if (content.getAttribute("contenteditable") === "true") return content;
  return content.querySelector<HTMLElement>('[contenteditable="true"]');
}

function hostFor(editor: HTMLElement): HTMLElement | null {
  return editor.closest<HTMLElement>(HOST_SELECTOR);
}

function bridgeIdFor(editor: HTMLElement): string | null {
  return (
    editor.closest<HTMLElement>("[data-wikilinks-bridge-id]")?.dataset
      .wikilinksBridgeId ?? null
  );
}

function isPromptbox(host: HTMLElement): boolean {
  return host.hasAttribute("data-promptbox");
}

function replacementRangeFor(
  editor: HTMLElement,
  caret: Range,
  charactersBeforeCaret: number,
  charactersAfterCaret: number,
): Range | null {
  if (!(caret.endContainer instanceof Text)) return null;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  let nodeIndex = nodes.indexOf(caret.endContainer);
  if (nodeIndex === -1) return null;
  let startNodeIndex = nodeIndex;
  let startOffset = caret.endOffset;
  let remainingBefore = charactersBeforeCaret;
  while (remainingBefore > startOffset) {
    remainingBefore -= startOffset;
    startNodeIndex -= 1;
    if (startNodeIndex < 0) return null;
    startOffset = nodes[startNodeIndex]!.data.length;
  }

  let endNodeIndex = nodeIndex;
  let endOffset = caret.endOffset;
  let remainingAfter = charactersAfterCaret;
  while (
    remainingAfter >
    nodes[endNodeIndex]!.data.length - endOffset
  ) {
    remainingAfter -= nodes[endNodeIndex]!.data.length - endOffset;
    endNodeIndex += 1;
    if (endNodeIndex >= nodes.length) return null;
    endOffset = 0;
  }
  const range = caret.cloneRange();
  range.setStart(
    nodes[startNodeIndex]!,
    startOffset - remainingBefore,
  );
  range.setEnd(nodes[endNodeIndex]!, endOffset + remainingAfter);
  return range;
}

function openTrigger(editor: HTMLElement): {
  query: string;
  replacementRange: Range;
} | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }
  const caret = selection.getRangeAt(0);
  if (!editor.contains(caret.endContainer)) return null;
  // Range.toString() does not insert line breaks between block elements, so a
  // rich editor's paragraphs would otherwise run together into one "line".
  const block =
    caret.endContainer.parentElement?.closest<HTMLElement>(BLOCK_SELECTOR) ??
    null;
  const container =
    block && block !== editor && editor.contains(block) ? block : editor;
  const beforeRange = caret.cloneRange();
  beforeRange.selectNodeContents(container);
  beforeRange.setEnd(caret.endContainer, caret.endOffset);
  const afterRange = caret.cloneRange();
  afterRange.selectNodeContents(container);
  afterRange.setStart(caret.endContainer, caret.endOffset);
  const beforeLine = beforeRange.toString().split("\n").at(-1)!;
  const afterLine = afterRange.toString().split("\n", 1)[0]!;
  const line = beforeLine + afterLine;
  const caretIndex = beforeLine.length;
  const openIndex = beforeLine.lastIndexOf("[[");
  if (openIndex === -1 || beforeLine.lastIndexOf("]]") > openIndex) {
    return null;
  }
  const closeIndex = line.indexOf("]]", openIndex + 2);
  if (closeIndex !== -1 && caretIndex > closeIndex + 1) return null;
  const queryEnd = closeIndex === -1 ? caretIndex : closeIndex;
  const query = line
    .slice(openIndex + 2, queryEnd)
    .split(/[|#^]/, 1)[0]!
    .trim();
  if (query === "" || query.length > MAX_QUERY_LENGTH) return null;
  const replacementRange = replacementRangeFor(
    editor,
    caret,
    caretIndex - openIndex,
    closeIndex === -1 ? 0 : closeIndex + 2 - caretIndex,
  );
  return replacementRange ? { query, replacementRange } : null;
}

function replaceSelection(range: Range, value: string): void {
  const selection = document.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted =
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, value);
  if (inserted) return;
  range.deleteContents();
  const text = document.createTextNode(value);
  range.insertNode(text);
  range.setStartAfter(text);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  text.parentElement?.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: value,
      inputType: "insertText",
    }),
  );
}

function wikilinkReference(source: string): string {
  return source.split(/[|#^]/, 1)[0]!.trim();
}

function caretAtPoint(
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?(
      x: number,
      y: number,
    ): { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?(x: number, y: number): Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position
      ? { node: position.offsetNode, offset: position.offset }
      : null;
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range
      ? { node: range.startContainer, offset: range.startOffset }
      : null;
  }
  return null;
}

function textLinkRange(link: ComposerTextLink): Range {
  const range = document.createRange();
  range.setStart(link.node, link.start);
  range.setEnd(link.node, link.end);
  return range;
}

function rangeContainsPoint(range: Range, x: number, y: number): boolean {
  const slack = 2;
  const measurable = range as Range & { getClientRects?: () => DOMRectList };
  if (typeof measurable.getClientRects !== "function") return false;
  for (const rect of Array.from(measurable.getClientRects())) {
    if (
      x >= rect.left - slack &&
      x <= rect.right + slack &&
      y >= rect.top - slack &&
      y <= rect.bottom + slack
    ) {
      return true;
    }
  }
  return false;
}

function anchorFor(range: Range): HoverAnchorRect {
  const rect = range.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

// A complete [[wikilink]] in the chat composer's plain text under the pointer.
// The live note editor decorates its own wikilinks, so only promptboxes count.
function composerTextLinkAt(x: number, y: number): ComposerTextLink | null {
  const editor = composerEditor(document.elementFromPoint(x, y));
  if (!editor) return null;
  const host = hostFor(editor);
  if (!host || !isPromptbox(host)) return null;
  const bridgeId = bridgeIdFor(editor);
  if (!bridgeId) return null;
  const caret = caretAtPoint(x, y);
  if (
    !caret ||
    !(caret.node instanceof Text) ||
    !editor.contains(caret.node)
  ) {
    return null;
  }
  for (const match of caret.node.data.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (caret.offset < start || caret.offset > end) continue;
    const reference = wikilinkReference(match[1]!);
    if (!reference) continue;
    const link = { editor, bridgeId, node: caret.node, start, end, reference };
    return rangeContainsPoint(textLinkRange(link), x, y) ? link : null;
  }
  return null;
}

function sameTextLink(
  left: ComposerTextLink | null,
  right: ComposerTextLink | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.node === right.node &&
    left.start === right.start &&
    left.end === right.end
  );
}

function dispatchHover(detail: ChatWikilinkHoverDetail): void {
  window.dispatchEvent(
    new CustomEvent<ChatWikilinkHoverDetail>(CHAT_WIKILINK_HOVER_EVENT, {
      detail,
    }),
  );
}

function dispatchLeave(detail: ChatWikilinkOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent<ChatWikilinkOpenDetail>(CHAT_WIKILINK_LEAVE_EVENT, {
      detail,
    }),
  );
}

function dispatchOpen(detail: ChatWikilinkOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent<ChatWikilinkOpenDetail>(CHAT_WIKILINK_OPEN_EVENT, {
      detail,
    }),
  );
}

export function mountComposerWikilinkAutocomplete(
  signal: AbortSignal,
): () => void {
  let active: ActiveAutocomplete | null = null;
  let menu: HTMLElement | null = null;
  let queryTimer: number | null = null;
  let nextRequestId = 0;
  let disposed = false;
  let hoveredSuggestion: { bridgeId: string; reference: string } | null = null;
  let textLink: ComposerTextLink | null = null;
  let lastPointer: { x: number; y: number } | null = null;

  const clearQueryTimer = () => {
    if (queryTimer !== null) window.clearTimeout(queryTimer);
    queryTimer = null;
  };
  const leaveSuggestion = () => {
    if (!hoveredSuggestion) return;
    dispatchLeave(hoveredSuggestion);
    hoveredSuggestion = null;
  };
  const removeMenu = () => {
    leaveSuggestion();
    menu?.remove();
    menu = null;
  };
  const close = () => {
    clearQueryTimer();
    removeMenu();
    active = null;
  };
  // Enter or a click inserts the wikilink and opens the note in the preview;
  // Tab only inserts.
  const apply = (index: number, open = true) => {
    const state = active;
    const suggestion = state?.suggestions[index];
    if (!state || !suggestion) return;
    state.editor.focus();
    replaceSelection(
      state.replacementRange.cloneRange(),
      `[[${suggestion.reference}]]`,
    );
    close();
    if (open) {
      dispatchOpen({
        bridgeId: state.bridgeId,
        reference: suggestion.reference,
      });
    }
  };
  const placeMenu = (list: HTMLElement, state: ActiveAutocomplete) => {
    if (state.placement !== "caret") return;
    list.classList.add("wikilink-autocomplete-caret");
    const range = state.replacementRange as Range & {
      getBoundingClientRect?: () => DOMRect;
    };
    if (typeof range.getBoundingClientRect !== "function") return;
    const hostRect = state.host.getBoundingClientRect();
    const caretRect = range.getBoundingClientRect();
    const width = Math.min(
      CARET_MENU_WIDTH_PX,
      Math.max(160, hostRect.width),
    );
    const left = Math.max(
      0,
      Math.min(caretRect.left - hostRect.left, hostRect.width - width),
    );
    list.style.left = `${left}px`;
    list.style.top = `${caretRect.bottom - hostRect.top + 6}px`;
    list.style.width = `${width}px`;
  };
  const renderMenu = () => {
    removeMenu();
    if (!active) return;
    const state = active;
    const list = document.createElement("div");
    list.className = "wikilink-autocomplete";
    list.dataset.wikilinkAutocomplete = "";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Wikilink suggestions");

    const heading = document.createElement("div");
    heading.className = "wikilink-autocomplete-heading";
    heading.textContent = "Notes";
    list.append(heading);

    const results = document.createElement("div");
    results.className = "wikilink-autocomplete-results";
    state.suggestions.forEach((suggestion, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wikilink-autocomplete-item";
      button.dataset.selected =
        index === state.selectedIndex ? "true" : "false";
      button.dataset.wikilinkReference = suggestion.reference;
      button.setAttribute("role", "option");
      button.setAttribute(
        "aria-selected",
        index === state.selectedIndex ? "true" : "false",
      );
      const label = document.createElement("span");
      label.className = "wikilink-autocomplete-label";
      label.textContent = suggestion.label;
      button.append(label);
      if (suggestion.directory) {
        const directory = document.createElement("span");
        directory.className = "wikilink-autocomplete-directory";
        directory.textContent = suggestion.directory;
        button.append(directory);
      }
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => apply(index));
      // Resting on a suggestion previews the note, exactly like hovering a
      // wikilink in a chat message; the card's Open action opens the preview.
      button.addEventListener("pointerenter", (event) => {
        leaveSuggestion();
        hoveredSuggestion = {
          bridgeId: state.bridgeId,
          reference: suggestion.reference,
        };
        dispatchHover({
          ...hoveredSuggestion,
          anchor: elementRect(button),
          ...(event.metaKey ? { backlinks: true } : {}),
        });
      });
      button.addEventListener("pointerleave", () => {
        if (hoveredSuggestion?.reference === suggestion.reference) {
          leaveSuggestion();
        }
      });
      results.append(button);
    });
    if (state.suggestions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wikilink-autocomplete-empty";
      empty.textContent = "No matching notes";
      results.append(empty);
    }
    list.append(results);

    const hint = document.createElement("div");
    hint.className = "wikilink-autocomplete-hint";
    hint.textContent =
      "↑↓ navigate   Enter insert and open   Tab insert   hover to preview   Esc close";
    list.append(hint);
    placeMenu(list, state);
    state.host.append(list);
    menu = list;
  };
  const select = (nextIndex: number) => {
    if (!active || active.suggestions.length === 0) return;
    active.selectedIndex =
      (nextIndex + active.suggestions.length) % active.suggestions.length;
    const items = menu?.querySelectorAll<HTMLElement>(
      ".wikilink-autocomplete-item",
    );
    items?.forEach((item, index) => {
      const selected = index === active!.selectedIndex;
      item.dataset.selected = selected ? "true" : "false";
      item.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) item.scrollIntoView({ block: "nearest" });
    });
  };
  const inspect = (target: EventTarget | null) => {
    const editor = composerEditor(target);
    const host = editor ? hostFor(editor) : null;
    const bridgeId = editor ? bridgeIdFor(editor) : null;
    if (
      !editor ||
      !host ||
      !bridgeId ||
      host.querySelector("[data-promptbox-typeahead-menu]")
    ) {
      close();
      return;
    }
    const trigger = openTrigger(editor);
    if (!trigger) {
      close();
      return;
    }
    clearQueryTimer();
    const requestId = ++nextRequestId;
    const previous = active;
    const keepCurrentMenu =
      previous?.editor === editor &&
      previous.bridgeId === bridgeId &&
      menu !== null;
    active = {
      editor,
      host,
      placement: isPromptbox(host) ? "above" : "caret",
      bridgeId,
      query: trigger.query,
      requestId,
      replacementRange: trigger.replacementRange,
      suggestions: keepCurrentMenu ? previous.suggestions : [],
      selectedIndex: keepCurrentMenu ? previous.selectedIndex : 0,
    };
    if (menu) {
      menu.dataset.loading = "true";
      placeMenu(menu, active);
    }
    queryTimer = window.setTimeout(() => {
      queryTimer = null;
      if (!active || active.requestId !== requestId) return;
      window.dispatchEvent(
        new CustomEvent<ComposerWikilinkQueryDetail>(
          COMPOSER_WIKILINK_QUERY_EVENT,
          {
            detail: { bridgeId, requestId, query: trigger.query },
          },
        ),
      );
    }, QUERY_DELAY_MS);
  };
  // Holding ⌘ over a finished [[wikilink]] in the composer previews it; ⌘-click
  // opens it. Without the modifier the pointer can rest on the box in peace.
  const syncTextLink = (modifierHeld: boolean) => {
    const next =
      modifierHeld && lastPointer
        ? composerTextLinkAt(lastPointer.x, lastPointer.y)
        : null;
    if (sameTextLink(textLink, next)) return;
    if (textLink) {
      dispatchLeave({
        bridgeId: textLink.bridgeId,
        reference: textLink.reference,
      });
    }
    textLink = next;
    if (next) {
      dispatchHover({
        bridgeId: next.bridgeId,
        reference: next.reference,
        anchor: anchorFor(textLinkRange(next)),
        immediate: true,
      });
    }
  };
  const onInput = (event: Event) => {
    inspect(event.target);
    syncTextLink(false);
  };
  const onSelectionChange = () => {
    const editor = composerEditor(document.activeElement);
    if (editor) inspect(editor);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Meta") syncTextLink(true);
    if (!active || !menu) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      select(active.selectedIndex + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      apply(active.selectedIndex, event.key === "Enter");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Meta") syncTextLink(false);
  };
  const onPointerMove = (event: PointerEvent) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    syncTextLink(event.metaKey);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!menu || !(event.target instanceof Node)) return;
    if (!menu.contains(event.target) && !active?.editor.contains(event.target)) {
      close();
    }
  };
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
    const link = composerTextLinkAt(event.clientX, event.clientY);
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    dispatchOpen({ bridgeId: link.bridgeId, reference: link.reference });
  };
  const onResults = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as Partial<ComposerWikilinkResultsDetail> | null;
    if (
      !active ||
      detail?.bridgeId !== active.bridgeId ||
      detail.requestId !== active.requestId ||
      !Array.isArray(detail.suggestions)
    ) {
      return;
    }
    active.suggestions = detail.suggestions.slice(0, 12);
    active.selectedIndex = 0;
    renderMenu();
  };

  document.addEventListener("input", onInput, true);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener(COMPOSER_WIKILINK_RESULTS_EVENT, onResults);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    close();
    syncTextLink(false);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener(COMPOSER_WIKILINK_RESULTS_EVENT, onResults);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
