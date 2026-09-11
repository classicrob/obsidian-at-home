// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_WIKILINK_QUERY_EVENT,
  COMPOSER_WIKILINK_RESULTS_EVENT,
  mountComposerWikilinkAutocomplete,
  type ComposerWikilinkQueryDetail,
  type ComposerWikilinkResultsDetail,
} from "./composer-autocomplete.js";
import {
  CHAT_WIKILINK_HOVER_EVENT,
  CHAT_WIKILINK_OPEN_EVENT,
  type ChatWikilinkHoverDetail,
  type ChatWikilinkOpenDetail,
} from "./chat-wikilinks.js";

describe("composer wikilink autocomplete", () => {
  it("queries from the caret and inserts the selected wikilink", async () => {
    document.body.innerHTML = `
      <div data-thread-window data-wikilinks-bridge-id="bridge-1">
        <form data-promptbox>
          <div data-promptbox-editor-content>
            <div id="editor" contenteditable="true">Ask about [[strat</div>
          </div>
        </form>
      </div>
    `;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    editor.focus();
    const text = editor.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);

    const queries: ComposerWikilinkQueryDetail[] = [];
    const onQuery = (event: Event) => {
      queries.push(
        (event as CustomEvent<ComposerWikilinkQueryDetail>).detail,
      );
    };
    window.addEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    const controller = new AbortController();
    const dispose = mountComposerWikilinkAutocomplete(controller.signal);
    fireEvent.input(editor);

    await waitFor(() => {
      expect(queries).toHaveLength(1);
    });
    expect(queries[0]).toMatchObject({
      bridgeId: "bridge-1",
      query: "strat",
    });

    window.dispatchEvent(
      new CustomEvent<ComposerWikilinkResultsDetail>(
        COMPOSER_WIKILINK_RESULTS_EVENT,
        {
          detail: {
            bridgeId: "bridge-1",
            requestId: queries[0]!.requestId,
            suggestions: [
              {
                reference: "notes/Strategy",
                label: "Strategy",
                directory: "notes/",
              },
            ],
          },
        },
      ),
    );

    expect(document.querySelector("[data-wikilink-autocomplete]")).not.toBeNull();
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe("Ask about [[notes/Strategy]]");
    expect(document.querySelector("[data-wikilink-autocomplete]")).toBeNull();

    dispose();
    window.removeEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    document.body.innerHTML = "";
  });

  it("tracks a closed wikilink span and keeps its menu open while results update", async () => {
    document.body.innerHTML = `
      <div data-thread-window data-wikilinks-bridge-id="bridge-closed">
        <form data-promptbox>
          <div data-promptbox-editor-content>
            <div id="closed-editor" contenteditable="true">Compare [[old note]] today</div>
          </div>
        </form>
      </div>
    `;
    const editor = document.querySelector<HTMLElement>("#closed-editor")!;
    const setCaretAfter = (needle: string) => {
      editor.focus();
      const text = editor.firstChild!;
      const range = document.createRange();
      range.setStart(
        text,
        text.textContent!.indexOf(needle) + needle.length,
      );
      range.collapse(true);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    };
    setCaretAfter("old");

    const queries: ComposerWikilinkQueryDetail[] = [];
    const onQuery = (event: Event) => {
      queries.push(
        (event as CustomEvent<ComposerWikilinkQueryDetail>).detail,
      );
    };
    window.addEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    const controller = new AbortController();
    const dispose = mountComposerWikilinkAutocomplete(controller.signal);
    fireEvent.input(editor);
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]!.query).toBe("old note");

    window.dispatchEvent(
      new CustomEvent<ComposerWikilinkResultsDetail>(
        COMPOSER_WIKILINK_RESULTS_EVENT,
        {
          detail: {
            bridgeId: "bridge-closed",
            requestId: queries[0]!.requestId,
            suggestions: [
              {
                reference: "notes/Old Note",
                label: "Old Note",
                directory: "notes/",
              },
            ],
          },
        },
      ),
    );
    expect(document.body.textContent).toContain("Old Note");

    editor.textContent = "Compare [[new note]] today";
    setCaretAfter("new");
    fireEvent.input(editor);
    expect(document.querySelector("[data-wikilink-autocomplete]")).not.toBeNull();
    expect(document.body.textContent).toContain("Old Note");
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]!.query).toBe("new note");

    window.dispatchEvent(
      new CustomEvent<ComposerWikilinkResultsDetail>(
        COMPOSER_WIKILINK_RESULTS_EVENT,
        {
          detail: {
            bridgeId: "bridge-closed",
            requestId: queries[1]!.requestId,
            suggestions: [
              {
                reference: "notes/New Note",
                label: "New Note",
                directory: "notes/",
              },
            ],
          },
        },
      ),
    );
    expect(document.body.textContent).toContain("New Note");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe(
      "Compare [[notes/New Note]] today",
    );

    dispose();
    window.removeEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    document.body.innerHTML = "";
  });
  it("autocompletes inside the live note editor and opens a suggestion with Enter", async () => {
    document.body.innerHTML = `
      <div class="wikilinks-live-editor" data-wikilinks-autocomplete-host data-wikilinks-bridge-id="note-1">
        <div class="tiptap" id="editor" contenteditable="true"><p>Intro paragraph with [[done]]</p><p>See [[strat</p></div>
      </div>
    `;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    editor.focus();
    const text = editor.lastElementChild!.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);

    const queries: ComposerWikilinkQueryDetail[] = [];
    const opens: ChatWikilinkOpenDetail[] = [];
    const hovers: ChatWikilinkHoverDetail[] = [];
    const onQuery = (event: Event) =>
      queries.push((event as CustomEvent<ComposerWikilinkQueryDetail>).detail);
    const onOpen = (event: Event) =>
      opens.push((event as CustomEvent<ChatWikilinkOpenDetail>).detail);
    const onHover = (event: Event) =>
      hovers.push((event as CustomEvent<ChatWikilinkHoverDetail>).detail);
    window.addEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    window.addEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    window.addEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
    const controller = new AbortController();
    const dispose = mountComposerWikilinkAutocomplete(controller.signal);
    fireEvent.input(editor);

    await waitFor(() => {
      expect(queries).toHaveLength(1);
    });
    // The earlier paragraph's finished link must not leak into the query.
    expect(queries[0]).toMatchObject({ bridgeId: "note-1", query: "strat" });

    window.dispatchEvent(
      new CustomEvent<ComposerWikilinkResultsDetail>(
        COMPOSER_WIKILINK_RESULTS_EVENT,
        {
          detail: {
            bridgeId: "note-1",
            requestId: queries[0]!.requestId,
            suggestions: [
              { reference: "notes/Strategy", label: "Strategy", directory: "notes/" },
            ],
          },
        },
      ),
    );
    const menu = document.querySelector<HTMLElement>("[data-wikilink-autocomplete]")!;
    expect(menu.classList.contains("wikilink-autocomplete-caret")).toBe(true);
    expect(menu.parentElement).toBe(editor.parentElement);

    const item = menu.querySelector<HTMLElement>(".wikilink-autocomplete-item")!;
    fireEvent.pointerEnter(item);
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({ bridgeId: "note-1", reference: "notes/Strategy" });

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.lastElementChild!.textContent).toBe("See [[notes/Strategy]]");
    expect(document.querySelector("[data-wikilink-autocomplete]")).toBeNull();
    expect(opens).toEqual([{ bridgeId: "note-1", reference: "notes/Strategy" }]);

    dispose();
    window.removeEventListener(COMPOSER_WIKILINK_QUERY_EVENT, onQuery);
    window.removeEventListener(CHAT_WIKILINK_OPEN_EVENT, onOpen);
    window.removeEventListener(CHAT_WIKILINK_HOVER_EVENT, onHover);
    document.body.innerHTML = "";
  });
});
