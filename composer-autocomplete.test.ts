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
});
