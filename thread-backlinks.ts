import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  initiator?: string;
  createdAt: number;
  text: string;
  sourceSeqStart: number;
}
export interface ThreadBacklinkOccurrence {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number;
  context: string;
  preview: string;
  focusLabel: string;
  userPrompt: string | null;
}

/** Keep complete wikilinks at excerpt boundaries, even when their targets are long. */
export function contextualMarkdownExcerpt(text: string, offset: number, size = 720): string {
  let start = Math.max(0, Math.min(offset - Math.floor(size / 3), text.length - size));
  let end = Math.min(text.length, start + size);
  for (const match of text.matchAll(/!?\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^\n]*?\)/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (from < start && to > start) start = from;
    if (from < end && to > end) end = to;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

interface TimelineRowLike {
  kind?: string;
  id?: string;
  role?: string;
  initiator?: string;
  createdAt?: number;
  startedAt?: number;
  sourceSeqStart?: number;
  text?: string;
  children?: TimelineRowLike[] | null;
}

export function conversationMessages(rows: readonly TimelineRowLike[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  function visit(items: readonly TimelineRowLike[]) {
    for (const row of items) {
      if (row.kind === "conversation" && row.id && typeof row.text === "string" && (row.role === "user" || row.role === "assistant")) {
        messages.push({ id: row.id, role: row.role, initiator: row.initiator, createdAt: row.createdAt ?? row.startedAt ?? 0, text: row.text, sourceSeqStart: row.sourceSeqStart ?? messages.length });
      }
      if (row.children) visit(row.children);
    }
  }
  visit(rows);
  return messages;
}

export async function loadThreadMessages(bb: BbPluginApi, threadId: string) {
  const messages = new Map<string, ConversationMessage>();
  let cursor: { anchorId: string; anchorSeq: number } | null = null;
  let truncated = false;
  let size = 0;
  for (let page = 0; page < 5; page++) {
    const timeline = await bb.sdk.threads.timeline({
      threadId, segmentLimit: "40", includeNestedRows: "true", summaryOnly: "false",
      ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}),
      signal: AbortSignal.timeout(8_000),
    });
    for (const message of conversationMessages(timeline.rows)) {
      if (messages.has(message.id)) continue;
      if (size + message.text.length > 400_000) { truncated = true; break; }
      messages.set(message.id, message);
      size += message.text.length;
    }
    const next = timeline.timelinePage?.olderCursor ?? null;
    if (truncated) break;
    if (!timeline.timelinePage?.hasOlderRows || !next) { truncated = false; break; }
    truncated = true;
    if (cursor?.anchorId === next.anchorId && cursor.anchorSeq === next.anchorSeq) break;
    cursor = next;
    truncated = false;
    if (page === 4) truncated = true;
  }
  return { messages: [...messages.values()].sort((a, b) => a.sourceSeqStart - b.sourceSeqStart), truncated };
}

export function extractThreadBacklinks(messages: ConversationMessage[], pointsAtNote: (reference: string) => boolean): { occurrences: ThreadBacklinkOccurrence[]; truncated: boolean } {
  const found: { index: number; offset: number }[] = [];
  messages.forEach((message, index) => {
    for (const match of message.text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const reference = match[1]!.split("|", 1)[0]!.trim();
      if (!reference.split("#", 1)[0] || !pointsAtNote(reference)) continue;
      found.push({ index, offset: match.index });
      break;
    }
  });
  const occurrences = found.slice(-8).map(({ index, offset }) => {
    const message = messages[index]!;
    let userPrompt: string | null = null;
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex--) {
      const previousUser = messages[previousIndex]!;
      if (previousUser.role !== "user" || (previousUser.initiator && previousUser.initiator !== "user") || /^\[bb system\]/i.test(previousUser.text.trimStart())) continue;
      const plain = previousUser.text
        .replace(/!?\[\[([^\]\n]+)\]\]/g, (_match, inner: string) => {
          const [reference, ...alias] = inner.split("|");
          return alias.length ? alias.join("|") : reference!;
        })
        .replace(/\[([^\]\n]+)\]\([^\n]*?\)/g, "$1")
        .replace(/(?:\*\*|__|~~|`)/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (plain) {
        const end = plain.length > 600 ? plain.lastIndexOf(" ", 600) : plain.length;
        userPrompt = plain.length > 600 ? `${plain.slice(0, end > 450 ? end : 600)}…` : plain;
      }
      break;
    }
    const focusLabel = `Mention · ${message.role === "user" ? "You" : "Assistant"}`;
    const blocks: string[] = [];
    const previous = messages[index - 1];
    if (previous) blocks.push(`### Before · ${previous.role === "user" ? "You" : "Assistant"}\n\n${contextualMarkdownExcerpt(previous.text, Math.max(0, previous.text.length - 500), 700)}`);
    blocks.push(`### ${focusLabel}\n\n${userPrompt ? `> You: ${userPrompt}\n\n` : ""}${contextualMarkdownExcerpt(message.text, offset, 1800)}`);
    const next = messages[index + 1];
    if (next) blocks.push(`### After · ${next.role === "user" ? "You" : "Assistant"}\n\n${contextualMarkdownExcerpt(next.text, 0, 700)}`);
    return { messageId: message.id, role: message.role, createdAt: message.createdAt, context: contextualMarkdownExcerpt(message.text, offset), preview: blocks.join("\n\n"), focusLabel, userPrompt };
  });
  return { occurrences, truncated: found.length > occurrences.length };
}
