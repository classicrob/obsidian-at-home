import { describe, expect, it } from "vitest";
import { mergeThreeWay, splitLines } from "./three-way-merge.js";

const base = [
  "# Meeting",
  "",
  "My notes go here.",
  "",
  "## Transcript",
  "",
  "00:01 Alice: Hello everyone.",
  "00:05 Bob: Hi Alice.",
  "",
].join("\n");

describe("mergeThreeWay", () => {
  it("splits lines the way jsdiff tokenizes them", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n")).toEqual(["a\n"]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a\r\n", "b\r\n"]);
  });

  it("combines edits in different regions", () => {
    const ours = base.replace("My notes go here.", "My notes: decide on the pivot.");
    const theirs = base.replace(
      "00:05 Bob: Hi Alice.",
      "00:05 Bob: Hi Alice.\n00:09 Alice: Let's begin.",
    );
    expect(mergeThreeWay(base, ours, theirs)).toEqual({
      ok: true,
      merged: base
        .replace("My notes go here.", "My notes: decide on the pivot.")
        .replace(
          "00:05 Bob: Hi Alice.",
          "00:05 Bob: Hi Alice.\n00:09 Alice: Let's begin.",
        ),
    });
  });

  it("keeps an append at the end while the user edits the top, even without a final newline from the editor", () => {
    // The Tiptap serializer drops the file's trailing line break.
    const ours = base
      .replace("# Meeting", "# Meeting with Bob")
      .replace(/\n$/, "");
    const theirs = `${base}00:12 Bob: Agreed.\n`;
    const result = mergeThreeWay(base, ours, theirs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.merged).toBe(
      `${base.replace("# Meeting", "# Meeting with Bob")}00:12 Bob: Agreed.\n`,
    );
  });

  it("keeps an append at the end while the user changes the last transcript line's neighbour", () => {
    const ours = base.replace("00:01 Alice: Hello everyone.", "00:01 Alice: Hello, everyone!");
    const theirs = `${base}00:12 Bob: Agreed.\n`;
    expect(mergeThreeWay(base, ours, theirs)).toEqual({
      ok: true,
      merged: `${ours}00:12 Bob: Agreed.\n`,
    });
  });

  it("takes identical edits once", () => {
    const edited = base.replace("My notes go here.", "Same change on both sides.");
    expect(mergeThreeWay(base, edited, edited)).toEqual({ ok: true, merged: edited });
    const oursExtra = edited.replace("# Meeting", "# Meeting (ours)");
    expect(mergeThreeWay(base, oursExtra, edited)).toEqual({
      ok: true,
      merged: oursExtra,
    });
  });

  it("returns theirs when only the file changed and ours when only the editor changed", () => {
    const theirs = `${base}More.\n`;
    expect(mergeThreeWay(base, base, theirs)).toEqual({ ok: true, merged: theirs });
    const ours = base.replace("# Meeting", "# Retro");
    expect(mergeThreeWay(base, ours, base)).toEqual({ ok: true, merged: ours });
    expect(mergeThreeWay(base, base.replace(/\n$/, ""), theirs)).toEqual({
      ok: true,
      merged: theirs,
    });
  });

  it("reports a conflict when both sides change the same line differently", () => {
    const ours = base.replace("My notes go here.", "Ours.");
    const theirs = base.replace("My notes go here.", "Theirs.");
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: false, reason: "conflict" });
  });

  it("reports a conflict when both sides insert different text at the same point", () => {
    const ours = `${base}Ours at the end.\n`;
    const theirs = `${base}Theirs at the end.\n`;
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: false, reason: "conflict" });
  });

  it("reports a conflict when the user edits inside a region the file deleted", () => {
    const ours = base.replace("00:01 Alice: Hello everyone.", "00:01 Alice: Hello everyone (edited).");
    const theirs = base.replace("00:01 Alice: Hello everyone.\n00:05 Bob: Hi Alice.\n", "");
    expect(mergeThreeWay(base, ours, theirs)).toEqual({ ok: false, reason: "conflict" });
  });

  it("merges into an empty base", () => {
    expect(mergeThreeWay("", "Ours", "")).toEqual({ ok: true, merged: "Ours" });
    expect(mergeThreeWay("", "", "Theirs\n")).toEqual({ ok: true, merged: "Theirs\n" });
    expect(mergeThreeWay("", "Ours\n", "Theirs\n")).toEqual({ ok: false, reason: "conflict" });
  });

  it("keeps a file without a final newline that way", () => {
    const short = "one\ntwo";
    const ours = "ONE\ntwo";
    const theirs = "one\ntwo\nthree";
    expect(mergeThreeWay(short, ours, theirs)).toEqual({ ok: true, merged: "ONE\ntwo\nthree" });
  });
});
