---
name: save-to-reading
description: Turn a YouTube video URL or a web article URL into a single Notion Reading DB entry. For video, pull and clean the transcript (yt-dlp captions, whisper fallback). For an article, fetch and lightly clean the author's text. File either with the right properties, a "Linked to" line, and a "## Notes" take. Creates the Reading DB if none exists. Use when asked to "add this to the Reading DB", "save this video / article / talk / essay to Notion", "file this link", or to turn a URL into a Reading entry with notes.
user-invocable: true
---

<!-- moochbot byline: built and maintained by Moochbot for mooch.agency. Consolidates the old transcribe-video + save-article-to-reading + /read skills into one. -->

Take a YouTube URL **or** an article URL and file it as a single Notion Reading DB page: cleaned body, correct properties, a "Linked to" line, and a "## Notes" section holding your take.

One skill, two inputs. Detect the input type first, then branch:

- **YouTube URL** (`youtube.com/watch`, `youtu.be/`, `/live/`, `/shorts/`, `/embed/`, or a bare 11-char video ID): transcript path (Step 1a).
- **Any other URL**: article path (Step 1b).

Everything after Step 1 is shared.

## Step 0: Find or create the Reading DB

This skill files into a Notion database. Mooch's own Reading DB ID is kept out of this public repo, so resolve the target in this order:

1. **`READING_DB` env var or local config** (a Notion data-source ID, `collection://...`). If set, use it.
2. **Search** the workspace for a database named "Reading" (or "📚 Reading") via the Notion tools and use its data source.
3. **No DB found:** create one with `notion-create-database`. Schema:
   - **Title** (title)
   - **URL** (url)
   - **Themes** (multi-select): AI workflow, Agency model, Distribution, Design, Decisions, Writing, Product, Strategy, Org / culture
   - **Saved** (created time)
   Tell the user the new DB URL so they can pin it as `READING_DB` for next time.

## Step 1a: Pull the transcript (video path)

Use the bundled helper. It lives next to this SKILL.md, so reference it relative to the skill directory (do not hardcode an absolute home path):

```
python3 ./scripts/yt_transcript.py <url_or_id> ./out/yt-<id>.md
```

- Always save to a file. Raw transcripts are long and you will re-read sections.
- Captions first (yt-dlp auto-subs or the YouTube transcript API). If captions are disabled, fall back to whisper on the downloaded audio. The helper documents both paths in its header.
- If neither captions nor a whisper run produce text, report that and stop. Do not scrape another way.

**Label speakers.** The source has no speaker labels, so never alternate blindly.
- Work out who speaks from handoff cues: intros, "I'll hand it to...", "thanks, <name>".
- Multi-presenter talk: segment into `## <Name>: <Section>` headers (colon, never a dash).
- Two-person interview: use host and guest names, lead each turn with the speaker.
- Solo video: no speaker labels, topic section headers if it is long.

**Clean and format.** Auto-captions mangle names, jargon, and product terms, so fix the obvious ones. Rewrite each section into tight prose. Keep the meaning, cut the waffle. This is a readable digest, not a verbatim dump. Apply house voice: British English, digits for numbers, active voice, no corporate vocab, no "not X but Y" antithesis, no em dashes anywhere including headers.

## Step 1b: Fetch and clean the article (article path)

- Fetch the full article text from the URL. You need the whole article, not a summary. If the fetch truncates, fetch the raw page and extract the body yourself.
- Drop everything that is not the article: nav, ads, cookie banners, newsletter prompts, share buttons, author bios, related-article lists, comments.
- Keep the author's headings, paragraphs, lists, and blockquotes.
- **Light touch.** This is the author's writing, not yours. Mechanical cleanup only: strip leftover boilerplate, fix broken line breaks and duplicated headings, convert any em dashes in the text to commas or colons for house consistency. Leave the author's spelling, numbers, and phrasing as they wrote them. House voice applies only to the Title and the Notes you write, not to the article body.

## Step 2: Create the Reading DB page

Use `notion-create-pages` with the resolved data source as the parent. Create the page in ONE call with the full body included. Do not create-then-update: the Notion update-page tool can silently wipe content.

- Icon: 📄
- Properties:
  - **Title**, byline format.
    - Video: `<Descriptive title>: <format> by <Channel>`, e.g. `Introducing the Developer Platform: keynote by Notion`.
    - Article: `<Article title> by <Author>`. If the author is unclear, use the publication.
  - **URL**: the canonical source URL (the `watch?v=` URL for video).
  - **Themes**: pick 2 to 4 from the fixed list above. No free text.
  - **Saved**: auto-set, leave it.
- Body, in order:
  1. The cleaned content (speaker-labelled sections for video; author's headings and paragraphs for an article).
  2. `---`
  3. `Linked to: [<short title>](<source url>)`
  4. `## Notes` (your take, Step 3).

## Step 3: Add the Notes

The "## Notes" section is your take, not a second summary. Relate the content to what the team does. Be honest. Say what to skip as readily as what to try. No sycophancy.

Use ### subheads with bullets. Useful shapes:

- `### The thesis worth keeping`: the one idea to remember.
- `### Worth stealing`: concrete tactics worth applying.
- `### Where this does not fit us`: honest pushback, what to ignore.

Notes are the only part you author, so full house voice applies: British English, digits for numbers, active voice, no corporate vocab, no sycophancy, no antithesis, no em dashes. Keep it short and opinionated, a few bullets per subhead.

## Step 4: Verify

- Fetch the page back with `notion-fetch` and confirm: properties set, themes from the fixed list, body intact, Notes present, no em dashes in the Title or Notes (and, for video, none in the body either).
- Return the new page URL to the user.

## Gotchas

- No em dashes, including in speaker headers. Use a colon: `## Jay Clam: Build any tool`.
- create-pages once, with the full body. To edit an existing page later, fetch it first and use targeted old_str / new_str. replace_content wipes the page.
- Themes must come from the fixed list. Do not invent new ones.
- Video with captions disabled and no usable audio returns nothing. Report it, do not scrape another way.
- The article body keeps the author's words. The no-em-dash and British-English rules apply only to the Title and Notes (plus converting the article's own em dashes).
