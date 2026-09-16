# Obsidian at Home

Edit and explore connected Markdown notes alongside your agents in BB. Includes wikilinks, recursive previews, backlinks, media embeds, and a history of the paths you explore.

Independent community plugin; not affiliated with Obsidian. Obsidian itself is not required. The plugin ID remains `wikilinks`.

## Install

Requires BB 0.41+ and Plugin SDK 0.4.84+.

```sh
bb plugin install git:https://github.com/classicrob/obsidian-at-home.git@main
```

For the tagged release, replace `@main` with `@semver:^0.1.0`. Build artifacts are included.

Open a thread whose workspace contains your notes. If another Markdown opener is pinned, select **Obsidian at Home** under **Settings → File openers**.

## Write and navigate

- **Edit Markdown:** Click document text to edit. Changes autosave; YAML frontmatter is preserved. External changes refresh automatically and merge with unsaved edits when they affect different lines. Overlapping changes offer **Reload** or **Overwrite**. Drafts and caret position survive editor remounts within the browser session.
- **Find notes:** Type `[[` in the note editor or thread composer. Search tolerates typos and out-of-order terms. Use arrows to select, **Enter** or click to insert and open, **Tab** to insert only, and **Escape** to dismiss.
- **Follow links:** Use `[[Note]]`, `[[folder/Note|Label]]`, or ordinary Markdown file links. Explicitly opening a missing note creates it and any parent folders; hovering does not.
- **Preview recursively:** Hover note links to read scrollable previews, then follow links inside them. Preview targets such as `[[Note#Heading]]` and `[[Note#^block-id]]` scroll to and highlight the target. Opening the full note does not yet scroll to its heading.
- **Explore other content:** Website links show sanitized previews; `.tldraw` links show embedded canvas thumbnails. Interactive canvas editing requires a separate canvas opener.

In the chat composer, **Command-hover** a completed wikilink to preview it and **Command-click** to open it. In note previews, **Command-hover** a wikilink to see contextual backlinks with heading breadcrumbs.

## Media and backlinks

Embed images, video, or audio with `![[Images/chart.jpg]]`, `![[demo.mp4]]`, or `![[recording.mp3]]`. Images support dimensions such as `![[chart.jpg|400]]` and `![[chart.jpg|400x300]]`. Video and audio have playback controls, including mobile playback and seeking.

Links and attachments resolve relative to the note, then the workspace root; bare filenames also search the workspace. Explicit Markdown paths can point elsewhere on the same BB host.

**Linked mentions** appear below each note. The optional **Vault Graph** plugin adds vault-wide note, canvas, thread, and unlinked mentions; otherwise, workspace backlinks remain available. Disable the section with:

```sh
bb plugin config wikilinks set documentBacklinks false
```

## Thinking trails and agents

Open **Thinking trails** in the thread panel to revisit paths, branches, dwell time, and clicks from deliberate preview navigation. Hovering signals curiosity; clicking is a stronger signal, not agreement.

Agents can query this history across threads with `query_thinking_trails`, optionally filtering by note. The bundled `obsidian-at-home` skill becomes available in new agent sessions without a separate install.

## Data and network

Notes remain Markdown files on your BB host. Unsaved drafts use browser session storage. Thinking trails are recorded automatically in BB-managed plugin SQLite storage, including note targets, timestamps, parent relationships, and interactions. Trails retrieved by an agent become part of its context.

Website previews fetch pages from the BB server without your browser's signed-in session or the site's scripts. Requests have time and size limits, validate redirects, and reject local/private destinations during URL validation. No separate account, API key, or analytics service is required.

## Development

```sh
npm install --include=dev
npm test
npm run typecheck
npm run build
bb plugin install .
```

MIT license. Bundled dependency notices are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
