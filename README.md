# Obsidian at Home

A community BB plugin for working with connected Markdown notes alongside your agents. Independent project; not affiliated with or endorsed by Obsidian. Obsidian itself is not required.

## Install and start

Requires BB 0.41 or later and Plugin SDK 0.4.84 or later. Install the tagged release:

```sh
bb plugin install git:https://github.com/classicrob/obsidian-at-home.git@semver:^0.1.0
```

Open a BB thread whose workspace contains your Markdown notes. In **Settings → File openers**, select **Obsidian at Home** for Markdown if another editor is pinned. Open a note, hover a link, or type `[[` in the thread composer to find another note.

The public name is Obsidian at Home; its stable plugin ID remains `wikilinks`. Existing integrations and settings use that ID. Release artifacts are included, so installing the Git release does not require building the editor yourself.

## What is included

- Markdown reading and editing with autosave and conflict detection.
- Wikilinks in notes and chat, plus note autocomplete in the chat composer.
- Obsidian attachment embeds for images, video, and audio in Markdown previews, including mobile playback.
- Recursive note and website previews, contextual backlinks, and canvas thumbnails.
- A Thinking trails panel and the `query_thinking_trails` agent tool.
- The bundled `obsidian-at-home` skill explaining these features to agents. It becomes available when a new agent session starts; no separate skill installation is needed.

**Optional companions:** Vault Graph enriches backlinks with vault-wide note, canvas, thread, and unlinked mentions. Without it, workspace backlinks still work. Interactive canvas editing needs a separately installed canvas opener such as Tldraw Preview; this plugin itself only previews embedded thumbnails. Neither companion is required for Markdown editing or Thinking Trails.

## Editing and exploration

Obsidian at Home provides a read-first live-preview editor for Markdown files and renders
Obsidian-style wikilinks and ordinary Markdown links in chat messages. The
editor displays rich formatting in place while retaining portable Markdown on
disk. The rendered document appears after the file read, while link resolution
and the rich editor prepare in the background. Clicking ordinary document text
switches to the warmed editor at that location. Changes autosave to the actual
file after a short idle delay. While a note remains open, external edits from
agents or other apps are detected within about half a second and replace the
rendered preview in place; returning focus to BB also triggers an immediate
check.

YAML frontmatter is shown as document properties and preserved byte-for-byte
when the body is edited. Saves use the file's SHA-256 as a compare-and-swap
guard. Changes from agents or other apps merge automatically when they affect
different lines from your unsaved edits. Overlapping edits pause saving and
offer **Reload** or an explicit **Overwrite**. Unsaved drafts, editing mode, and
the caret are retained in session storage across editor remounts; a restored
draft is merged with any newer file content before editing resumes.
Wikilink syntax collapses to its readable label while idle and reappears when
the caret enters it.

Editor links use BB's native file navigation, while chat links resolve against
the thread workspace or host and open the same BB editor.
Hovering a resolved link shows a theme-aware rendered Markdown excerpt after a
short intent delay. The hover preview omits YAML frontmatter, stays open while
the pointer is over it, and includes an **Open note** action for semantic zoom
into the full file. Wikilinks inside hover previews are interactive too, so
hovering them opens another rendered excerpt in a recursive preview cascade.
Wikilinks ending in `.tldraw` use the canvas file's embedded static thumbnail,
scaled to fit the hover card without loading an interactive canvas. Note previews
contain the full note body and scroll to and highlight `#Heading` or `#^block-id`
targets; block ID markers are hidden in the rendered preview.
Ordinary Markdown links ending in `.tldraw` use the same hover thumbnail,
including percent-encoded paths and canvas filenames containing parentheses.
HTTP and HTTPS links show a sanitized, scrollable page excerpt without running
the linked page's scripts. Remote Markdown renders as Markdown, and links in web
previews can open further recursive web previews. Long preview titles wrap to
the card width instead of being truncated.

Hold **Command** while hovering a Markdown wikilink to show contextual
backlinks instead of the note excerpt. Each result includes the referencing
Markdown block and, when present, its heading and subheading trail as
breadcrumbs. Note links in backlink excerpts and backlink source titles support
the same recursive hover previews and Command-hover contextual backlinks. The
reverse-link index is built only for this explicit gesture and cached briefly
for subsequent backlink hovers.

Deliberate hover navigation is recorded as a thinking trail in the plugin's
BB-managed SQLite database. A preview qualifies after 450 ms, immediately on
scroll or interaction, or immediately when clicked. Recursive previews retain
their parent edges, so returning to an earlier card and taking another path is
stored as a branch. The trail is committed two seconds after the whole hover
chain closes, on a context change, after inactivity, or when the page is
hidden. Clicking a note is a stronger signal and commits immediately; a trail
that begins on the clicked note within ten seconds is joined to the prior
trail. Open **Thinking trails** from the thread panel to see local timestamps,
duration, paths, dwell time, backlink traversal, clicks, and signal strength.
Agents in newly started sessions can query the same history with the
`query_thinking_trails` tool. Hover history is treated as curiosity rather
than endorsement.

In an existing thread's chat composer or the live note editor, type `[[`
followed by part of a note name to open autocomplete. Search terms can be out of order and tolerate small
typos. Use the arrow keys to move, **Enter** or a click to insert the selected
workspace-relative wikilink and open its note, **Tab** to insert only, and
**Escape** to dismiss the menu. Hover a suggestion for a preview. In the chat
composer, Command-hover a completed wikilink to preview it and Command-click
to open it. The live editor places its autocomplete menu at the caret. The workspace
path index is warmed when the thread opens, cached while typing, and refreshed
in the background. The menu follows the wikilink containing the caret, whether
the link is still open or already closed, and stays visible while its results
update. Choosing a result replaces that complete wikilink span.

## Images, video, and audio

Embed workspace attachments with Obsidian syntax: `![[Images/chart.jpg]]`,
`![[Images/demo.mp4]]`, or `![[Images/recording.mp3]]`. Images render inline;
video and audio show native playback controls. Image dimensions such as
`![[chart.jpg|400]]` and `![[chart.jpg|400x300]]` are supported.

Paths resolve relative to the note first, then the workspace root. A bare
filename also searches workspace attachments. Playback controls keep the note
in preview mode. Temporary BB preview URLs allow attachments to load through
remote connections, and byte-range streaming supports mobile Safari playback
and seeking.

## Backlinks in document

Every open note ends with a **Linked mentions** section, like Obsidian's
"Backlinks in document" setting. It sits below the content inside the same
scroll container, so it scrolls with the note in both preview and editing
modes. Backlinks are grouped by source (note, canvas, or BB thread, with a
small kind label), and each occurrence shows its heading breadcrumb and the
context line with the `[[wikilink]]` to this note highlighted. Note and canvas
titles are the same hover-previewing links used elsewhere (hover for an
excerpt, Command-hover for their own backlinks, click to open; canvases open in
the tldraw opener), and thread titles open the thread. A collapsed-by-default
**Unlinked mentions** subsection lists notes that mention the title without
linking it. Both toggles remember their state in `localStorage`.

The data comes from the **Vault Graph** (optional, separately installed)
plugin over its `resolve_target` and `note_panel` RPC, so it covers the whole
vault, including canvases, threads, and unlinked mentions. Plugins cannot
subscribe to another plugin's realtime channel, so the section refetches when
this note's own save completes (after a short delay for the indexer), when the
window regains focus or visibility, and when the opener re-announces the file.
If vault-graph is not installed, disabled, or unreachable (a 404 or network
error), or the file is outside the vault, the section falls back to this
plugin's own `preview_file` contextual backlinks for the current workspace and
omits unlinked mentions. Failures never reach the React tree; an empty result
shows "No backlinks yet". The vault-graph side panel keeps working alongside it.

Turn the section off with the `documentBacklinks` plugin setting
(Extensions → Plugins → Obsidian at Home, or
`bb plugin config wikilinks set documentBacklinks false`).

Supported forms:

- `[[Note name]]`
- `[[Note name|Visible alias]]`
- `[[folder/Note name]]`
- `[[Note name#Heading]]` (opens the note; heading scrolling is not yet part of
  BB's file-opener contract)
- `[[Canvas name.tldraw]]`
- `[Visible label](folder/Canvas%20name.tldraw)`
- `[Visible label](Note name.md)`
- `[Visible label](/absolute/path/to/Note%20name.md)`
- `[Visible label](file:///absolute/path/to/Note%20name.md)`

Basename-only links are resolved against Markdown files in the workspace.
Same-folder matches win, followed by root-relative matches and then the
shortest deterministic basename match. Explicit Markdown paths are checked
directly and may point elsewhere on the same host. Missing targets remain
clickable with a dashed underline and use the inferred path. Explicitly opening
a missing Markdown note creates an empty file and any parent folders, using an
atomic create-only write so another client's new note is preserved. Hovering a
missing link does not create a note.

## Development

```sh
npm install --include=dev
npm test
npm run typecheck
npm run build
bb plugin install .
```

After installation, choose **Obsidian at Home** for Markdown under
**Settings → File openers** if another opener has been pinned.

## Data and network behavior

Notes remain Markdown files on the selected BB host. Unsaved editor drafts are also kept in browser session storage to recover across editor remounts. Edits write to those files through BB's file API. Thinking trails are recorded automatically during qualifying note-preview navigation and stored in BB-managed plugin SQLite storage. They contain note labels and file targets, parent relationships, timestamps, dwell time, and interactions. The agent tool can query recent trails across threads, optionally filtered by note. Retrieved trail information becomes part of that agent's context; the engagement score is a heuristic, not a statement of agreement.

Hovering a website link makes an HTTP(S) request from the BB server to that site. The preview does not use your browser's signed-in session or execute the site's scripts. Requests have time and size limits, reject local/private destinations at URL validation, and validate redirects. No separate account, API key, or analytics service is required.

## License

MIT. Bundled dependency notices are in `THIRD_PARTY_NOTICES.txt`.
