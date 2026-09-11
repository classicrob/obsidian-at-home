import { diffLines } from "diff";

/**
 * Line-based three-way merge (a small diff3) used when a note changes on disk
 * while the editor holds unsaved text. `base` is the last content both sides
 * agreed on (the file as last loaded or saved), `ours` is the editor's current
 * markdown and `theirs` is the file as it is on disk now.
 *
 * Edits that touch disjoint line ranges of `base` are combined; identical
 * edits are taken once; overlapping edits that differ are a conflict and the
 * caller falls back to asking the user.
 */
export type ThreeWayMergeResult =
  | { ok: true; merged: string }
  | { ok: false; reason: "conflict" };

/** Replace base lines `[start, end)` with `text` (already newline-joined). */
interface LineEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Mirrors jsdiff's line tokenizer: each token is a line including its own
 * line break, so `count` on change objects lines up with these indexes.
 */
export function splitLines(value: string): string[] {
  const parts = value.split(/(\n|\r\n)/);
  if (!parts[parts.length - 1]) parts.pop();
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2) lines[lines.length - 1] += parts[index];
    else lines.push(parts[index]!);
  }
  return lines;
}

function editsAgainst(base: string, target: string): LineEdit[] {
  const edits: LineEdit[] = [];
  let position = 0;
  let pending: LineEdit | null = null;
  for (const change of diffLines(base, target)) {
    const count = change.count ?? 0;
    if (!change.added && !change.removed) {
      if (pending) edits.push(pending);
      pending = null;
      position += count;
      continue;
    }
    pending ??= { start: position, end: position, text: "" };
    if (change.removed) {
      pending.end += count;
      position += count;
    } else {
      pending.text += change.value;
    }
  }
  if (pending) edits.push(pending);
  return edits;
}

function isInsertion(edit: LineEdit): boolean {
  return edit.start === edit.end;
}

/** Whether `left` ends before `right` starts, so both can apply. */
function precedes(left: LineEdit, right: LineEdit): boolean {
  if (left.end > right.start) return false;
  // Two insertions at the same point have no defined order; treat as a
  // conflict unless they are the same text (handled by the caller).
  return !(isInsertion(left) && isInsertion(right) && left.start === right.start);
}

function sameEdit(left: LineEdit, right: LineEdit): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.text === right.text
  );
}

function withTrailingNewline(value: string): string {
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

export function mergeThreeWay(
  base: string,
  ours: string,
  theirs: string,
): ThreeWayMergeResult {
  if (ours === theirs || ours === base) return { ok: true, merged: theirs };
  if (theirs === base) return { ok: true, merged: ours };

  // The editor serializes without a final line break while files usually end
  // with one; that difference alone must not make the last line a conflict.
  const normalizedBase = withTrailingNewline(base);
  const normalizedOurs = withTrailingNewline(ours);
  const normalizedTheirs = withTrailingNewline(theirs);
  if (normalizedOurs === normalizedTheirs || normalizedOurs === normalizedBase) {
    return { ok: true, merged: theirs };
  }
  if (normalizedTheirs === normalizedBase) return { ok: true, merged: ours };

  const baseLines = splitLines(normalizedBase);
  const oursEdits = editsAgainst(normalizedBase, normalizedOurs);
  const theirsEdits = editsAgainst(normalizedBase, normalizedTheirs);

  const combined: LineEdit[] = [];
  let ourIndex = 0;
  let theirIndex = 0;
  while (ourIndex < oursEdits.length || theirIndex < theirsEdits.length) {
    const our = oursEdits[ourIndex];
    const their = theirsEdits[theirIndex];
    if (our && their && sameEdit(our, their)) {
      combined.push(our);
      ourIndex += 1;
      theirIndex += 1;
      continue;
    }
    if (!their || (our && precedes(our, their))) {
      combined.push(our!);
      ourIndex += 1;
      continue;
    }
    if (!our || precedes(their, our)) {
      combined.push(their);
      theirIndex += 1;
      continue;
    }
    return { ok: false, reason: "conflict" };
  }

  let merged = "";
  let position = 0;
  for (const edit of combined) {
    merged += baseLines.slice(position, edit.start).join("");
    merged += edit.text;
    position = edit.end;
  }
  merged += baseLines.slice(position).join("");

  // Keep the file's own convention for the final line break.
  if (!theirs.endsWith("\n") && merged.endsWith("\n")) {
    merged = merged.slice(0, -1);
  }
  return { ok: true, merged };
}
