// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { InstantMarkdownPreview } from "./instant-markdown-preview.js";
import { CalloutEditor } from "./callout-editor.js";
import { calloutStyle } from "./callouts.js";

afterEach(cleanup);
const preview = (content: string) => render(<InstantMarkdownPreview content={content} renderNoteLink={(ref, children) => <a href={`#${ref}`}>{children}</a>} renderUrlLink={(url, children) => <a href={url}>{children}</a>} />);
const makeEditor = (content: string) => new Editor({ extensions: [StarterKit, CalloutEditor, Markdown.configure({ html: true })], content });
const markdown = (editor: Editor) => editor.storage.markdown.getMarkdown() as string;

describe("callout rendering", () => {
  it("renders formatted titles, wikilinks, body Markdown and nested callouts", () => {
    const view = preview('> [!WARNING]+ **Heads up** [[Note|link]]\n> Body with *emphasis*.\n>\n> > [!tip] Nested\n> > - One\n> > - Two');
    const callout = view.container.querySelector('details[data-callout="warning"]')!;
    expect(callout.hasAttribute('open')).toBe(true);
    expect(callout.querySelector('summary strong')?.textContent).toBe('Heads up');
    expect(callout.querySelector('summary a')?.textContent).toBe('link');
    expect(callout.querySelector('.callout-content em')?.textContent).toBe('emphasis');
    expect(callout.querySelector('[data-callout="tip"] li')?.textContent).toBe('One');
    expect(view.container.textContent).not.toContain('[!');
  });
  it("uses defaults, title-only callouts, aliases and unknown-type fallback", () => {
    const view = preview('> [!note]\n> Body\n\n> [!faq]-\n\n> [!custom-type] Only title');
    expect(view.container.querySelector('.callout-title-inner')?.textContent).toBe('Note');
    expect(view.container.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(view.container.querySelector('details summary')?.textContent).toContain('Faq');
    expect(calloutStyle('faq')).toEqual(calloutStyle('question'));
    expect(calloutStyle('custom-type')).toEqual(calloutStyle('note'));
    expect(calloutStyle('constructor')).toEqual(calloutStyle('note'));
    expect(calloutStyle('__proto__')).toEqual(calloutStyle('note'));
    expect(view.container.querySelector('[data-callout="custom-type"] .callout-content')?.textContent?.trim()).toBe('');
  });
  it("does not transform ordinary quotes or fenced code", () => {
    const view = preview('> Ordinary quote\n\n```md\n> [!warning] Code\n```');
    expect(view.container.querySelector('blockquote')?.textContent).toContain('Ordinary quote');
    expect(view.container.querySelector('.callout')).toBeNull();
    expect(view.container.querySelector('code')?.textContent).toContain('[!warning]');
  });
});

describe("editable callouts", () => {
  it("round trips nested callouts, formatted titles, metadata, folds and body blocks", () => {
    const editor = makeEditor('> [!WARNING|custom]+ **Heads up** [[Note]]\n> Body *emphasis*.\n>\n> > [!tip]- Nested\n> >\n> > - One\n> > - Two\n\n> Regular quote');
    const second = makeEditor('');
    try {
      expect(editor.state.doc.firstChild?.type.name).toBe('callout');
      expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe('Heads up [[Note]]');
      expect(editor.state.doc.firstChild?.child(1).textContent).toBe('Body emphasis.');
      expect(markdown(editor)).toContain('[!WARNING|custom]+ **Heads up**');
      second.commands.setContent(markdown(editor));
      expect(second.getJSON()).toEqual(editor.getJSON());
      const toggle = editor.view.dom.querySelector('[data-callout="tip"] button')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const before = markdown(editor);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(markdown(editor)).toBe(before);
    } finally { editor.destroy(); second.destroy(); }
  });
  it("keeps a missing title separate from its body and preserves edits", () => {
    const editor = makeEditor('> [!note]\n> Body\n\n> [!tip]- Title only');
    const second = makeEditor('');
    try {
      expect(editor.state.doc.firstChild?.firstChild?.content.size).toBe(0);
      expect(editor.state.doc.firstChild?.child(1).textContent).toBe('Body');
      editor.commands.insertContentAt(2, 'New title');
      second.commands.setContent(markdown(editor));
      expect(second.getJSON()).toEqual(editor.getJSON());
      expect(markdown(editor)).toContain('[!note] New title');
    } finally { editor.destroy(); second.destroy(); }
  });
});
