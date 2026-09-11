import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { decodeLocalMarkdownPath } from "./wikilink-markdown.js";
import {
  parseMarkdownDocument,
  restoreWikilinkEscapes,
} from "./markdown-document.js";

const wikilinkDecorationsKey = new PluginKey<DecorationSet>(
  "wikilink-live-preview",
);

export function wikilinkDecorations(
  doc: Parameters<typeof DecorationSet.create>[0],
  selection: { from: number; to: number },
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock || node.type.spec.code) return;
    const text = node.textBetween(0, node.content.size, "\n", "\n");
    const pattern = /(?<!!)\[\[([^\]\n]+)\]\]/g;
    for (const match of text.matchAll(pattern)) {
      const source = match[1]!;
      const separator = source.indexOf("|");
      const reference = (separator === -1
        ? source
        : source.slice(0, separator)
      ).trim();
      if (!reference) continue;
      const start = position + 1 + match.index!;
      const end = start + match[0].length;
      const active =
        selection.from <= end &&
        selection.to >= start &&
        (selection.from !== selection.to ||
          (selection.from >= start && selection.from <= end));
      if (active) {
        decorations.push(
          Decoration.inline(start, end, {
            class: "wikilink wikilink-editor wikilink-editor-source",
            "data-wikilink-reference": reference,
            "data-wikilink-active": "true",
            role: "link",
          }),
        );
        continue;
      }
      const labelStart =
        separator === -1 ? start + 2 : start + 2 + separator + 1;
      const labelEnd = end - 2;
      if (labelStart > start) {
        decorations.push(
          Decoration.inline(start, labelStart, {
            class: "wikilink-editor-syntax",
          }),
        );
      }
      if (labelStart < labelEnd) {
        decorations.push(
          Decoration.inline(labelStart, labelEnd, {
            class: "wikilink wikilink-editor",
            "data-wikilink-reference": reference,
            role: "link",
          }),
        );
      }
      decorations.push(
        Decoration.inline(labelEnd, end, {
          class: "wikilink-editor-syntax",
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

const WikilinkLivePreview = Extension.create({
  name: "wikilinkLivePreview",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: wikilinkDecorationsKey,
        state: {
          init: (_config, state) =>
            wikilinkDecorations(state.doc, state.selection),
          apply: (transaction) =>
            wikilinkDecorations(transaction.doc, transaction.selection),
        },
        props: {
          decorations: (state) => wikilinkDecorationsKey.getState(state),
        },
      }),
    ];
  },
});

function referenceElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-wikilink-reference], a[href]");
}

function referenceFor(element: HTMLElement): string | null {
  const wikilink = element.dataset.wikilinkReference;
  if (wikilink) return wikilink;
  if (!(element instanceof HTMLAnchorElement)) return null;
  return decodeLocalMarkdownPath(element.getAttribute("href") ?? "");
}

function editorMarkdown(editor: Editor, frontmatter: string, breaks: string) {
  const markdown = (
    editor.storage.markdown as { getMarkdown(): string }
  ).getMarkdown();
  return frontmatter + breaks + restoreWikilinkEscapes(markdown);
}

export interface EditorSelection {
  from: number;
  to: number;
}

/**
 * Where a caret that sat at `position` in `previous` belongs in `next` after
 * an external change replaced the differing region. Text before the change
 * keeps its position, text after it shifts by the size difference, and a
 * caret inside the changed region stays within the region's new extent.
 */
export function mapPositionAcrossChange(
  previous: ProseMirrorNode,
  next: ProseMirrorNode,
  position: number,
): number {
  const size = next.content.size;
  const start = previous.content.findDiffStart(next.content);
  if (start === null) return Math.min(position, size);
  const end = previous.content.findDiffEnd(next.content);
  let endA = end?.a ?? previous.content.size;
  let endB = end?.b ?? size;
  if (endA < start) {
    endB += start - endA;
    endA = start;
  } else if (endB < start) {
    endA += start - endB;
    endB = start;
  }
  if (position <= start) return Math.min(position, size);
  if (position >= endA) return Math.min(position + (endB - endA), size);
  return Math.min(position, endB, size);
}

export function LiveMarkdownEditor({
  bridgeId,
  initialValue,
  active,
  focusRequest,
  selectionRequest,
  onReady,
  onFirstRender,
  onMarkdownChange,
  onReferenceOpen,
  onReferenceHover,
  onReferenceLeave,
}: {
  bridgeId: string;
  initialValue: string;
  active: boolean;
  focusRequest: { left: number; top: number; sequence: number } | null;
  /** Restores a caret from a previous mount of this note, e.g. after a plugin reload. */
  selectionRequest: (EditorSelection & { sequence: number }) | null;
  onReady(): void;
  onFirstRender(markdown: string): void;
  onMarkdownChange(markdown: string, selection: EditorSelection): void;
  onReferenceOpen(reference: string, element: HTMLElement): void;
  onReferenceHover(
    reference: string,
    element: HTMLElement,
    showBacklinks: boolean,
  ): void;
  onReferenceLeave(): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const readyRef = useRef(onReady);
  const firstRef = useRef(onFirstRender);
  const changeRef = useRef(onMarkdownChange);
  const hoverRef = useRef(onReferenceHover);
  const activeReferenceRef = useRef<{
    reference: string;
    element: HTMLElement;
  } | null>(null);
  readyRef.current = onReady;
  firstRef.current = onFirstRender;
  changeRef.current = onMarkdownChange;
  hoverRef.current = onReferenceHover;

  // The editor instance is created once per mount. Parents remount it (via
  // key) when the file path changes; a save echo or an external refresh only
  // updates the content in place so the caret and undo history survive.
  const documentRef = useRef(parseMarkdownDocument(initialValue));
  const lastMarkdownRef = useRef(initialValue);

  useEffect(() => {
    if (!rootRef.current) return;
    const document = parseMarkdownDocument(initialValue);
    documentRef.current = document;
    lastMarkdownRef.current = initialValue;
    const editor = new Editor({
      element: rootRef.current,
      extensions: [
        StarterKit,
        Link.configure({ openOnClick: false, autolink: true }),
        Image.configure({ allowBase64: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true, lastColumnResizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: "Start writing…" }),
        WikilinkLivePreview,
        Markdown.configure({
          html: true,
          tightLists: true,
          bulletListMarker: "-",
          linkify: true,
        }),
      ],
      content: document.body,
      autofocus: false,
    });
    editorRef.current = editor;
    const getMarkdown = () =>
      editorMarkdown(
        editor,
        documentRef.current.frontmatter,
        documentRef.current.bodyLeadingBreaks,
      );
    firstRef.current(getMarkdown());
    readyRef.current();
    editor.on("update", () => {
      const markdown = getMarkdown();
      lastMarkdownRef.current = markdown;
      const { from, to } = editor.state.selection;
      changeRef.current(markdown, { from, to });
    });
    return () => {
      editorRef.current = null;
      editor.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    // Our own save echoes back the markdown this editor last emitted; ignore it.
    if (initialValue === lastMarkdownRef.current) return;
    const document = parseMarkdownDocument(initialValue);
    documentRef.current = document;
    lastMarkdownRef.current = initialValue;
    const previous = editor.state.doc;
    const { from, to } = editor.state.selection;
    const focused = editor.isFocused;
    editor.commands.setContent(document.body, false);
    if (focused) {
      const next = editor.state.doc;
      editor.commands.setTextSelection({
        from: mapPositionAcrossChange(previous, next, from),
        to: mapPositionAcrossChange(previous, next, to),
      });
    }
    readyRef.current();
  }, [initialValue]);

  useEffect(() => {
    if (!active || !selectionRequest || !editorRef.current) return;
    const timer = window.setTimeout(() => {
      const editor = editorRef.current;
      if (!editor || editor.isDestroyed) return;
      const size = editor.state.doc.content.size;
      try {
        editor
          .chain()
          .focus()
          .setTextSelection({
            from: Math.min(selectionRequest.from, size),
            to: Math.min(selectionRequest.to, size),
          })
          .run();
      } catch {
        editor.commands.focus("end");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, selectionRequest]);

  useEffect(() => {
    if (!active || !focusRequest || !editorRef.current) return;
    const timer = window.setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      try {
        const position = editor.view.posAtCoords({
          left: focusRequest.left,
          top: focusRequest.top,
        });
        editor.commands.focus(position?.pos ?? "end");
      } catch {
        editor.commands.focus("end");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, focusRequest]);

  useEffect(() => {
    const onModifierChange = (event: KeyboardEvent) => {
      const hovered = activeReferenceRef.current;
      if (event.key !== "Meta" || !hovered) return;
      hoverRef.current(
        hovered.reference,
        hovered.element,
        event.type === "keydown",
      );
    };
    window.addEventListener("keydown", onModifierChange);
    window.addEventListener("keyup", onModifierChange);
    return () => {
      window.removeEventListener("keydown", onModifierChange);
      window.removeEventListener("keyup", onModifierChange);
    };
  }, []);

  const openReference = (event: ReactMouseEvent<HTMLDivElement>) => {
    const element = referenceElement(event.target);
    if (!element) return;
    const reference = referenceFor(element);
    if (!reference) return;
    if (
      element.dataset.wikilinkActive === "true" &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onReferenceOpen(reference, element);
  };
  const hoverReference = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = referenceElement(event.target);
    if (!element) return;
    const reference = referenceFor(element);
    if (reference) {
      activeReferenceRef.current = { reference, element };
      onReferenceHover(reference, element, event.metaKey);
    }
  };
  const leaveReference = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = referenceElement(event.target);
    if (!element) return;
    if (
      event.relatedTarget instanceof Node &&
      element.contains(event.relatedTarget)
    ) {
      return;
    }
    activeReferenceRef.current = null;
    onReferenceLeave();
  };

  return (
    <div
      className="wikilinks-live-editor"
      data-wikilinks-autocomplete-host=""
      data-wikilinks-bridge-id={bridgeId}
      onClick={openReference}
      onPointerOver={hoverReference}
      onPointerOut={leaveReference}
    >
      <div ref={rootRef} />
    </div>
  );
}
