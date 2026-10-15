// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { conversationMessages, contextualMarkdownExcerpt, extractThreadBacklinks, loadThreadMessages, type ConversationMessage } from "./thread-backlinks.js";
import { ThreadBacklinkGroup, type ThreadBacklinkData } from "./thread-backlink-group.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const message = (id: string, text: string, role: "user" | "assistant" = "assistant"): ConversationMessage => ({ id, text, role, createdAt: 1791300000000, sourceSeqStart: Number(id) || 1 });
afterEach(cleanup);

describe('thread backlink context', () => {
  it('extracts real conversation messages and omits tools and reasoning', () => {
    const rows = [{ kind: 'turn', children: [{ ...message('1', '[[Note]]'), kind: 'conversation' }, { id: '2', kind: 'work', text: '[[Note]]', role: 'assistant' }] }];
    expect(conversationMessages(rows).map(row => row.id)).toEqual(['1']);
  });
  it('centers on the mentioning message, includes its neighbors, and ignores self-heading links', () => {
    const messages = [message('1', 'What led to this?', 'user'), message('2', 'Consider [[Folder/Note#Section|the argument]].'), message('3', 'I agree.', 'user'), message('4', '[[#Note]]')];
    const result = extractThreadBacklinks(messages, ref => ref.startsWith('Folder/Note'));
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({ messageId: '2', role: 'assistant', context: messages[1]!.text, focusLabel: 'Mention · Assistant', userPrompt: 'What led to this?' });
    expect(result.occurrences[0]!.preview).toContain('What led to this?');
    expect(result.occurrences[0]!.preview).toContain('I agree.');
  });
  it('uses the nearest preceding user message across assistant updates and resets on the next prompt', () => {
    const result = extractThreadBacklinks([
      message('1', 'Explain [[Topic|this idea]].', 'user'),
      message('2', 'Looking into it.'),
      message('3', 'Still checking.'),
      { ...message('system', 'Automated result', 'user'), initiator: 'system' },
      message('legacy-system', '[bb system] Thread completed.', 'user'),
      message('4', 'See [[Note]].'),
      message('5', 'How could I use it?', 'user'),
      message('6', 'Use [[Note#Example]].'),
    ], ref => ref.startsWith('Note'));
    expect(result.occurrences.map(item => item.userPrompt)).toEqual(['Explain this idea.', 'How could I use it?']);
    expect(result.occurrences[0]!.preview).toContain('> You: Explain this idea.');
    expect(extractThreadBacklinks([message('1', '[[Note]]')], () => true).occurrences[0]!.userPrompt).toBeNull();
  });
  it('does not invent passages when a mention is unavailable', () => {
    expect(extractThreadBacklinks([message('1', 'No reference here')], () => true)).toEqual({ occurrences: [], truncated: false });
  });
  it('preserves entire long wikilinks at both excerpt boundaries', () => {
    const long = `[[${'Long title '.repeat(80)}|readable label]]`;
    const text = `Beginning ${long} middle ${long} end`;
    const excerpt = contextualMarkdownExcerpt(text, long.length, 720);
    expect(excerpt.match(/\[\[/g)?.length).toBe(excerpt.match(/\]\]/g)?.length);
    expect(excerpt).toContain(long);
  });
  it('bounds repeated mentions and shows the most recent occurrences chronologically', () => {
    const result = extractThreadBacklinks(Array.from({ length: 20 }, (_, i) => message(String(i), '[[Note]] [[Note#heading]]')), () => true);
    expect(result.occurrences).toHaveLength(8);
    expect(result.occurrences[0]?.messageId).toBe('12');
    expect(result.truncated).toBe(true);
  });
  it('paginates to older mentions and de-duplicates overlapping rows', async () => {
    const timeline = vi.fn().mockResolvedValueOnce({ rows: [{ ...message('3', 'Latest'), kind: 'conversation' }], timelinePage: { hasOlderRows: true, olderCursor: { anchorId: '3', anchorSeq: 3 } } }).mockResolvedValueOnce({ rows: [{ ...message('1', '[[Note]]'), kind: 'conversation' }, { ...message('3', 'Latest'), kind: 'conversation' }], timelinePage: { hasOlderRows: false, olderCursor: null } });
    const result = await loadThreadMessages({ sdk: { threads: { timeline } } } as unknown as BbPluginApi, 'thread');
    expect(result.messages.map(row => row.id)).toEqual(['1', '3']);
    expect(result.truncated).toBe(false);
    expect(timeline.mock.calls[1]![0]).toMatchObject({ beforeAnchorId: '3', beforeAnchorSeq: '3' });
  });
});

describe('thread backlink presentation', () => {
  const group = { key: 'thread:t1', kind: 'thread' as const, title: 'A discussion', target: null, threadId: 't1', occurrences: [] };
  const data: ThreadBacklinkData = { ...extractThreadBacklinks([message('1', 'Why this?', 'user'), message('2', 'Because **this matters**: [[Note|the note]].'), message('3', 'That helps.', 'user')], () => true), links: [{ reference: 'Note', exists: true, target: { kind: 'host', hostId: 'h', path: '/notes/Note.md' } }] };
  it('shows a dated excerpt and hovers the surrounding conversation instead of a title-only row', async () => {
    const onOpen = vi.fn();
    const view = render(<ThreadBacklinkGroup group={group} loadContext={async () => data} onOpen={onOpen} />);
    await view.findByText('this matters');
    expect(view.container.querySelector('strong')?.textContent).toBe('this matters');
    expect(view.container.querySelector('time')).not.toBeNull();
    expect(view.getByLabelText('Preceding user message').textContent).toBe('You: Why this?');
    const excerpt = view.container.querySelector('.wikilinks-thread-context')!;
    expect(excerpt.hasAttribute('tabindex')).toBe(false);
    vi.useFakeTimers();
    try {
      fireEvent.pointerEnter(excerpt);
      fireEvent.focus(view.getByText('the note'));
      act(() => vi.advanceTimersByTime(500));
      expect(view.queryByRole('dialog')).toBeNull();
    } finally { vi.useRealTimers(); }
    fireEvent.pointerEnter(view.getByRole('button', { name: 'A discussion' }));
    const card = await view.findByRole('dialog', { name: 'Preview of A discussion' });
    expect(card.textContent).toContain('Why this?');
    expect(card.textContent).toContain('That helps.');
    expect(card.querySelector('.wikilink-hover-focus')?.textContent).toBe('Mention · Assistant');
    fireEvent.click(view.getByRole('button', { name: 'Open thread' }));
    expect(onOpen).toHaveBeenCalledWith('t1');
    expect(view.queryByRole('dialog')).toBeNull();
  });
  it('has keyboard preview and Escape dismissal', async () => {
    const view = render(<ThreadBacklinkGroup group={group} loadContext={async () => data} onOpen={() => {}} />);
    await view.findByText('this matters');
    fireEvent.focus(view.getByRole('button', { name: 'A discussion' }));
    await view.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
  });
  it('retains thread navigation when loading fails and offers retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(data);
    const view = render(<ThreadBacklinkGroup group={group} loadContext={load} onOpen={() => {}} />);
    fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    await view.findByText('this matters');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not leak a pending hover after unmount', async () => {
    const view = render(<ThreadBacklinkGroup group={group} loadContext={async () => data} onOpen={() => {}} />);
    await view.findByText('this matters');
    fireEvent.pointerEnter(view.getByRole('button', { name: 'A discussion' }));
    view.unmount();
    await waitFor(() => expect(document.querySelector('[data-wikilink-hover-preview]')).toBeNull());
  });
});
