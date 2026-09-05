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
  promptbox: HTMLElement;
  bridgeId: string;
  query: string;
  requestId: number;
  replacementRange: Range;
  suggestions: ComposerWikilinkSuggestion[];
  selectedIndex: number;
}

const QUERY_DELAY_MS = 85;
const MAX_QUERY_LENGTH = 160;

function composerEditor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const content = target.closest<HTMLElement>(
    "[data-promptbox-editor-content]",
  );
  if (!content) return null;
  if (content.getAttribute("contenteditable") === "true") return content;
  return content.querySelector<HTMLElement>('[contenteditable="true"]');
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
  const beforeRange = caret.cloneRange();
  beforeRange.selectNodeContents(editor);
  beforeRange.setEnd(caret.endContainer, caret.endOffset);
  const afterRange = caret.cloneRange();
  afterRange.selectNodeContents(editor);
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

export function mountComposerWikilinkAutocomplete(
  signal: AbortSignal,
): () => void {
  let active: ActiveAutocomplete | null = null;
  let menu: HTMLElement | null = null;
  let queryTimer: number | null = null;
  let nextRequestId = 0;
  let disposed = false;

  const clearQueryTimer = () => {
    if (queryTimer !== null) window.clearTimeout(queryTimer);
    queryTimer = null;
  };
  const removeMenu = () => {
    menu?.remove();
    menu = null;
  };
  const close = () => {
    clearQueryTimer();
    removeMenu();
    active = null;
  };
  const apply = (index: number) => {
    const state = active;
    const suggestion = state?.suggestions[index];
    if (!state || !suggestion) return;
    state.editor.focus();
    replaceSelection(
      state.replacementRange.cloneRange(),
      `[[${suggestion.reference}]]`,
    );
    close();
  };
  const renderMenu = () => {
    removeMenu();
    if (!active) return;
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
    active.suggestions.forEach((suggestion, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wikilink-autocomplete-item";
      button.dataset.selected = index === active!.selectedIndex ? "true" : "false";
      button.setAttribute("role", "option");
      button.setAttribute(
        "aria-selected",
        index === active!.selectedIndex ? "true" : "false",
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
      results.append(button);
    });
    if (active.suggestions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "wikilink-autocomplete-empty";
      empty.textContent = "No matching notes";
      results.append(empty);
    }
    list.append(results);

    const hint = document.createElement("div");
    hint.className = "wikilink-autocomplete-hint";
    hint.textContent = "↑↓ navigate   Enter or Tab select   Esc close";
    list.append(hint);
    active.promptbox.append(list);
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
    const promptbox = editor?.closest<HTMLElement>("[data-promptbox]");
    const threadWindow = editor?.closest<HTMLElement>(
      "[data-thread-window][data-wikilinks-bridge-id]",
    );
    const bridgeId = threadWindow?.dataset.wikilinksBridgeId;
    if (
      !editor ||
      !promptbox ||
      !bridgeId ||
      promptbox.querySelector("[data-promptbox-typeahead-menu]")
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
      promptbox,
      bridgeId,
      query: trigger.query,
      requestId,
      replacementRange: trigger.replacementRange,
      suggestions: keepCurrentMenu ? previous.suggestions : [],
      selectedIndex: keepCurrentMenu ? previous.selectedIndex : 0,
    };
    if (menu) menu.dataset.loading = "true";
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
  const onInput = (event: Event) => inspect(event.target);
  const onSelectionChange = () => {
    const editor = composerEditor(document.activeElement);
    if (editor) inspect(editor);
  };
  const onKeyDown = (event: KeyboardEvent) => {
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
      apply(active.selectedIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!menu || !(event.target instanceof Node)) return;
    if (!menu.contains(event.target) && !active?.editor.contains(event.target)) {
      close();
    }
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
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener(COMPOSER_WIKILINK_RESULTS_EVENT, onResults);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    close();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener(COMPOSER_WIKILINK_RESULTS_EVENT, onResults);
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
