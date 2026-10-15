// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "tiptap-markdown";
import { OutlineEditor, outlineBranches, outlineFoldingKey } from "./outline-editor.js";
import { InstantMarkdownPreview } from "./instant-markdown-preview.js";

afterEach(cleanup);
const preview = (content: string) => render(<InstantMarkdownPreview content={content} renderNoteLink={(ref, children) => <a href={`#${ref}`}>{children}</a>} renderUrlLink={(url, children) => <a href={url}>{children}</a>} />);
const editors: Editor[] = [];
const makeEditor = (content: string) => {
  const editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), OutlineEditor, Markdown.configure({ tightLists: true })], content });
  editors.push(editor);
  return editor;
};
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));
const button = (editor: Editor, label: string) => editor.view.dom.querySelector(`button[aria-label="${label}"]`)!;
const markdown = (editor: Editor) => editor.storage.markdown.getMarkdown() as string;

const content = '# One\n\nIntro\n\n### Inner\n\n- Parent\n  - Child\n    - Grandchild\n- Sibling\n\n# Two\n\nOutside';

describe("outline preview", () => {
  it("folds a heading through lower-level headings and stops at the next peer", () => {
    const view = preview(content);
    fireEvent.click(view.getByRole('button', { name: 'Collapse One' }));
    expect(view.getByText('Grandchild').closest('[hidden]')).not.toBeNull();
    expect(view.getByText('Outside').closest('[hidden]')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Expand One' }));
    expect(view.getByText('Grandchild').closest('[hidden]')).toBeNull();
  });
  it("retains nested folds when an ancestor is expanded and keeps links interactive", () => {
    const view = preview('# [[Note|Title]]\n\n- Parent\n  - Child\n    - Grandchild');
    fireEvent.click(view.getByRole('button', { name: 'Collapse Child' }));
    fireEvent.click(view.getByRole('button', { name: 'Collapse Title' }));
    fireEvent.click(view.getByRole('button', { name: 'Expand Title' }));
    expect(view.getByRole('button', { name: 'Expand Child' }).getAttribute('aria-expanded')).toBe('false');
    expect(view.getByRole('link', { name: 'Title' }).getAttribute('href')).toBe('#Note');
    expect(view.getByText('Grandchild').closest('li.is-collapsed')?.textContent).toContain('Child');
  });
  it("does not add toggles to empty sections, leaf bullets, or fenced Markdown", () => {
    const view = preview('# Empty\n\n# Section\n\n- Leaf\n\n```md\n# Code\n- Parent\n  - Child\n```');
    expect(view.queryByRole('button', { name: 'Collapse Empty' })).toBeNull();
    expect(view.getAllByRole('button')).toHaveLength(1);
    expect(view.container.querySelector('code')?.textContent).toContain('# Code');
  });
});

describe("outline editor", () => {
  it("folds heading sections without changing Markdown, history, or emitting saves", () => {
    const editor = makeEditor(content);
    const before = markdown(editor);
    const update = vi.fn();
    editor.on('update', update);
    fireEvent.click(button(editor, 'Collapse One'));
    expect(editor.view.dom.querySelector('h3')?.classList.contains('wikilinks-outline-hidden')).toBe(true);
    expect(Array.from(editor.view.dom.querySelectorAll('p')).find(p => p.textContent === 'Outside')?.closest('.wikilinks-outline-hidden')).toBeNull();
    expect(markdown(editor)).toBe(before);
    expect(update).not.toHaveBeenCalled();
    expect(editor.can().undo()).toBe(false);
    fireEvent.click(button(editor, 'Expand One'));
    expect(editor.view.dom.querySelector('.wikilinks-outline-hidden')).toBeNull();
  });
  it("folds only descendants of parent bullets and keeps their nested fold state", () => {
    const editor = makeEditor(content);
    fireEvent.click(button(editor, 'Collapse Child'));
    fireEvent.click(button(editor, 'Collapse Parent'));
    const sibling = Array.from(editor.view.dom.querySelectorAll('li')).find(li => li.textContent === 'Sibling')!;
    expect(sibling.closest('.wikilinks-outline-hidden')).toBeNull();
    fireEvent.click(button(editor, 'Expand Parent'));
    expect(button(editor, 'Expand Child').getAttribute('aria-expanded')).toBe('false');
    expect(editor.view.dom.querySelector('.wikilinks-outline-hidden')?.textContent).toBe('Grandchild');
  });
  it("moves the caret out of a newly collapsed section and reveals keyboard-selected descendants", () => {
    const editor = makeEditor(content);
    const grandchild = outlineBranches(editor.state.doc).find(branch => branch.label === 'Child')!.children[0]!.from + 3;
    editor.commands.setTextSelection(grandchild);
    fireEvent.click(button(editor, 'Collapse One'));
    expect(editor.state.selection.from).toBe(1);
    editor.commands.setTextSelection(grandchild);
    expect(button(editor, 'Collapse One')).not.toBeNull();
  });
  it("maps folds through edits before a section and drops them on replacement", () => {
    const editor = makeEditor('Preamble\n\n# Title\n\nBody');
    fireEvent.click(button(editor, 'Collapse Title'));
    editor.commands.insertContentAt(1, 'New ');
    expect(button(editor, 'Expand Title')).not.toBeNull();
    editor.commands.setContent('# Replacement\n\nOther body', false);
    expect(outlineFoldingKey.getState(editor.state)?.size).toBe(0);
    expect(button(editor, 'Collapse Replacement')).not.toBeNull();
  });
  it.each(['- Parent\n- Child', '1. Parent\n2. Child', '- [ ] Parent\n- [ ] Child'])("indents and outdents with Tab for %s", source => {
    const editor = makeEditor(source);
    let childPos = 0;
    editor.state.doc.descendants((node, position) => { if (node.isText && node.text === 'Child') childPos = position; });
    editor.commands.setTextSelection(childPos);
    const before = markdown(editor);
    expect(editor.commands.keyboardShortcut('Tab')).toBe(true);
    expect(outlineBranches(editor.state.doc).some(branch => branch.label === 'Parent')).toBe(true);
    expect(markdown(editor)).not.toBe(before);
    editor.commands.keyboardShortcut('Shift-Tab');
    expect(markdown(editor)).toBe(before);
  });
  it("round trips edits while descendants are collapsed", () => {
    const editor = makeEditor('- Parent\n  - Child\n    - Grandchild');
    fireEvent.click(button(editor, 'Collapse Parent'));
    editor.commands.insertContentAt(3, 'Updated ');
    const second = makeEditor(markdown(editor));
    expect(second.getJSON()).toEqual(editor.getJSON());
    expect(markdown(second)).toContain('Grandchild');
  });
});
