---
name: obsidian-at-home
description: Use Obsidian at Home (the BB wikilinks plugin) for linked Markdown notes, recursive hover previews, contextual backlinks, note autocomplete, and Thinking Trails. Use when the user asks how to use these features in BB, wants to reconstruct a path they explored through notes, or needs to write wikilinks that render correctly in Markdown tables. For vault-wide full-text or structural queries, prefer the separate Vault Graph tools when available.
---

# Obsidian at Home

This BB plugin supplies a Markdown editor, link previews, and navigation history. Its stable plugin ID is `wikilinks`.

## Help the user navigate

- Open a note inside a BB thread whose workspace contains the notes. If another Markdown opener is pinned, select **Obsidian at Home** under **Settings → File openers**.
- Click document text to edit it. Changes autosave to the original file. External edits to different lines merge automatically; unsaved drafts and the caret can recover across editor remounts. If external edits conflict, use the presented **Reload** or **Overwrite** choice according to the user's intended version.
- In an existing thread's composer or the live note editor, type `[[` and part of a note name. Arrow keys select; Enter or clicking a suggestion inserts and opens the note; Tab inserts only; Escape dismisses. Hover a suggestion for a preview. In the composer, Command-hover a completed wikilink to preview it and Command-click to open it.
- Hover a note link for its excerpt. Links inside previews open further previews. Command-hover shows contextual backlinks. The **Open note** action opens the full file.
- Website links show scrollable excerpts; `.tldraw` links show embedded static thumbnails. Interactive canvas editing requires a separate canvas opener.
- Hover previews scroll to and highlight `[[Note#Heading]]` and `[[Note#^block-id]]` targets. Opening the full file still does not scroll to the target.
- Explicitly opening a missing Markdown note creates it and its parent folders. Hovering does not create files.

## Write wikilinks

Use `[[Note title]]` or `[[Note title|Display text]]`. Put heading and block targets before the alias, as in `[[Note#Heading|Section]]`.

Inside Markdown table cells, escape the alias separator with exactly one backslash: `[[Note title\|Display text]]`. Otherwise the table parser treats it as a column boundary. This applies in both chat and notes. Outside tables, use the ordinary unescaped separator. Do not escape the pipes that delimit table columns.

## Reconstruct prior exploration

Call `query_thinking_trails` when the user's prior navigation would help: for example, "What was I exploring?" or "How did I get from A to B?" Pass `note` to filter by note name or path and a small `limit` (maximum 20).

For date-specific requests, inspect returned timestamps in the user's timezone; the tool has no date filter or pagination, so recent results may not cover the requested period.

Read the returned branch structure, click markers, timestamps, and dwell time. Describe hover as curiosity and clicks as stronger interest. Do not infer endorsement or claim a causal explanation that the trail does not establish. Say when no matching trail was found; ordinary file-opening history is not necessarily recorded.

The tool searches saved trails across threads. It does not replay navigation or change notes. Do not claim to query historical content of a note; the trail records navigation metadata, not note snapshots.

For the user-facing history, open **Thinking trails** from a thread's panel actions. **All** and **This thread** filter the display. Qualifying previews record automatically after 450 ms or immediately on interaction; leaving the chain for two seconds saves it. Clicking saves immediately, and continuing from that note within ten seconds can join the next path.

## Know the companion boundaries

For full-text note search, tags, properties, graph queries, canvas relationships, or thread mentions, use `vault_search`, `vault_query`, `vault_backlinks`, `vault_note`, or `vault_schema` when Vault Graph is installed. This plugin supplies only `query_thinking_trails` as an agent tool. If Vault Graph is unavailable, use ordinary file tools for the user's requested search and explain the narrower scope when relevant.

**Linked mentions** under each document uses Vault Graph when available and falls back to workspace backlinks otherwise. Unlinked mentions and vault-wide canvas/thread results require Vault Graph. The section is controlled by `bb plugin config wikilinks set documentBacklinks false` (or `true`).

No separate Obsidian application, account, or API key is required. For complete behavior and development instructions, read the plugin's README.md.
