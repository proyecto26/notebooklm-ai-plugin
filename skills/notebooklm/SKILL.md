---
name: notebooklm
description: Interact with Google NotebookLM (notebook.google.com) notebooks — chat with the AI, generate artifacts (slides, audio, video, mind maps, quizzes, flashcards, infographics, reports, data tables), manage sources (add URLs, YouTube, files, text), run research (fast/deep web research), and manage notes. Use whenever the user mentions NotebookLM, a notebook.google.com URL, audio overviews, or wants to query, create content from, or manage their notebook sources — even if they don't say "NotebookLM" explicitly.
---

# NotebookLM AI Plugin

Drive Google NotebookLM (`https://notebook.google.com`) from the terminal. Both
`notebook.google.com` and `notebooklm.google.com` notebook URLs are accepted.

Supports:
- Chat with Notebook AI (source-grounded Q&A with citations)
- Slide Deck generation (PPTX/PDF)
- Audio Overview (M4A — deep dive, brief, critique, debate formats)
- Video Overview (MP4 — auto, classic, whiteboard, kawaii, anime, watercolor, retro_print, heritage, paper_craft styles)
- Mind Map (JSON tree)
- Flashcards / Quiz (interactive HTML)
- Infographic (PNG — landscape, portrait, square; 11 visual styles)
- Report (Markdown — briefing doc, study guide, blog post, custom prompt)
- Data Table (CSV)
- Source management (add URLs, YouTube, files, pasted text; list, delete)
- Fast/Deep web research with auto-import
- Notes management (create, update, delete, list)
- Notebook library management (add, list, search, activate) + listing your account's notebooks

All commands run from this skill directory:

```bash
cd <skill-dir>   # the folder containing SKILL.md
npx -y bun scripts/main.ts <command> [options]
```

## Quick start

```bash
# 1. Authenticate (opens Chrome for Google login; cookies are cached)
npx -y bun scripts/main.ts login

# 2. Check the session and see your notebooks (ids + source counts)
npx -y bun scripts/main.ts notebooks remote

# 3. Save one as the default
npx -y bun scripts/main.ts notebooks add https://notebook.google.com/notebook/<id> --name "My Research"

# 4. Use it
npx -y bun scripts/main.ts chat --question "What are the key findings?"
npx -y bun scripts/main.ts generate slide_deck --output slides.pdf
npx -y bun scripts/main.ts generate audio --format deep_dive --length long
npx -y bun scripts/main.ts generate quiz --difficulty medium --quantity more --output quiz.html
npx -y bun scripts/main.ts generate data_table --instructions "Compare the frameworks" --output table.csv
```

## Authentication

`login` launches Chrome (with a dedicated profile under the data dir) and waits for
you to sign in at `notebook.google.com`, then captures the Google session cookies.
Cookies expire after a few weeks; any command that hits a login redirect tells you to
run `login --force`.

```bash
npx -y bun scripts/main.ts login            # reuse cached cookies if still valid
npx -y bun scripts/main.ts login --force    # always re-open Chrome
npx -y bun scripts/main.ts notebooks remote # fast auth check: lists notebooks from your account
```

Every RPC call fetches a fresh CSRF token (`SNlM0e`) and session id (`FdrFJe`) from the
app page, so nothing else needs refreshing. If the origin changes again, set
`NOTEBOOKLM_BASE_URL` (or edit `scripts/constants.ts`).

## Commands

### Notebook management

```bash
npx -y bun scripts/main.ts notebooks remote                 # notebooks on your Google account (live)
npx -y bun scripts/main.ts notebooks list                   # local library
npx -y bun scripts/main.ts notebooks add <url> [--name <name>] [--description <desc>] [--topics <t1,t2>]
npx -y bun scripts/main.ts notebooks remove <id>
npx -y bun scripts/main.ts notebooks activate <id>          # default for every other command
npx -y bun scripts/main.ts notebooks search <query>
```

### Chat with Notebook AI

```bash
npx -y bun scripts/main.ts chat --question "What are the key findings?" --notebook <url|id>
npx -y bun scripts/main.ts chat --question "Tell me more about that" --conversation-id <id>
npx -y bun scripts/main.ts chat --question "Summarize the methodology" --json   # answer + citations
```

Chat uses all *ready* sources in the notebook. Citations reference source ids (see `sources list`).

### Source management

```bash
npx -y bun scripts/main.ts sources list --notebook <url|id>          # id, title, type, status, url
npx -y bun scripts/main.ts sources add-url https://example.com/article
npx -y bun scripts/main.ts sources add-youtube https://youtube.com/watch?v=xxx
npx -y bun scripts/main.ts sources add-text --title "My Notes" --content "Important findings..."
npx -y bun scripts/main.ts sources add-file ./paper.pdf
npx -y bun scripts/main.ts sources delete <sourceId>
```

New sources show `status: processing` for a little while; generation and chat only use
sources whose status is `ready`. Supported files: PDF, TXT, MD, DOCX, PPTX, CSV, EPUB,
images (PNG, JPG, WEBP), audio/video.

### Research

```bash
npx -y bun scripts/main.ts research fast --query "latest AI agent frameworks"   # ~1–3 min
npx -y bun scripts/main.ts research deep --query "state of LLM reasoning"       # ~5–10 min, produces a report
npx -y bun scripts/main.ts research fast --query "topic" --import                # import found sources
npx -y bun scripts/main.ts research status
```

### Notes

```bash
npx -y bun scripts/main.ts notes list
npx -y bun scripts/main.ts notes create --title "Key Takeaways" --content "1. Finding one..."
npx -y bun scripts/main.ts notes update <noteId> --title "Updated" --content "New content"
npx -y bun scripts/main.ts notes delete <noteId>
```

### Artifacts

```bash
npx -y bun scripts/main.ts artifacts list                 # everything in the Studio panel, with status
npx -y bun scripts/main.ts generate <type> [options]
```

Types: `slide_deck`, `audio`, `video`, `mind_map`, `flashcards`, `quiz`, `infographic`, `report`, `data_table`

Generation is asynchronous on Google's side: the command creates the artifact, polls
the Studio list until it is completed *and* its download URL is available (audio/video
can take 10–20 minutes), then downloads it. If auto-download fails, the URL is printed
so it can be opened in a browser.

## Options

### Global options

| Option | Description |
|--------|-------------|
| `--notebook <url\|id>` | Notebook URL or library id (defaults to the active notebook) |
| `--output <path>` | Output file path (auto-named under the data dir if omitted) |
| `--instructions <text>` | Custom instructions / focus for generation |
| `--language <code>` | Output language (default `en`) |
| `--json` | Machine-readable output |

### Per-type options

| Type | Options |
|------|---------|
| `audio` | `--format deep_dive\|brief\|critique\|debate`, `--length short\|default\|long` |
| `video` | `--style auto\|classic\|whiteboard\|kawaii\|anime\|watercolor\|retro_print\|heritage\|paper_craft`, `--format explainer\|brief\|cinematic\|short` |
| `slide_deck` | `--format detailed\|presenter\|pdf\|pptx`, `--length default\|short` (PPTX by default; `--format pdf` or an `.pdf` output path selects the PDF) |
| `quiz`, `flashcards` | `--difficulty easy\|medium\|hard`, `--quantity fewer\|standard\|more` |
| `infographic` | `--orientation landscape\|portrait\|square`, `--detail concise\|standard\|detailed`, `--style auto\|sketch_note\|professional\|bento_grid\|editorial\|instructional\|bricks\|clay\|anime\|kawaii\|scientific` |
| `report` | `--format briefing\|study_guide\|blog_post\|custom`, `--prompt "<full prompt>"` (custom) |
| `mind_map` | `--instructions` only |
| `data_table` | `--instructions` (what to tabulate) |

### Output formats

| Type | Output |
|------|--------|
| `slide_deck` | PPTX (or PDF) |
| `audio` | M4A |
| `video` | MP4 |
| `mind_map` | JSON tree `{ name, children: [...] }` |
| `flashcards`, `quiz` | self-contained interactive HTML |
| `infographic` | PNG |
| `report` | Markdown |
| `data_table` | CSV (headers + rows) |

## Environment variables

| Variable | Description |
|----------|-------------|
| `NOTEBOOKLM_BASE_URL` | App origin override (default `https://notebook.google.com`) |
| `NOTEBOOKLM_DATA_DIR` | Data directory (cookies, library, Chrome profile, outputs) |
| `NOTEBOOKLM_COOKIE_PATH` | Cookie file path |
| `NOTEBOOKLM_CHROME_PATH` / `NOTEBOOKLM_CHROME_PROFILE_DIR` | Chrome executable / profile |
| `NOTEBOOKLM_OUTPUT_DIR` | Default output directory |
| `NOTEBOOKLM_BL` | Build label sent on chat requests (not validated by the server) |

## Rate limits (free tier)

| Resource | Limit |
|----------|-------|
| Audio/video overviews | 3 per day |
| Reports/flashcards/quizzes | 10 per day |
| Daily chats | 50 |
| Notebooks | 100, 50 sources each |

Quota rejections surface as an `RPCError` of kind `rate_limit`.

## Troubleshooting

| Symptom | Meaning / fix |
|---------|---------------|
| `redirected (302) to …/login` | Cookies expired → `login --force` |
| `redirected … The app origin may have changed` | Google moved the app again → set `NOTEBOOKLM_BASE_URL` |
| `RPC xxxx not present in response … method ID may have changed` | Google rotated an RPC id → update `scripts/rpc-types.ts` (compare with [notebooklm-py](https://github.com/teng-lin/notebooklm-py)) |
| `INVALID_ARGUMENT` / `FAILED_PRECONDITION` | Payload shape rejected — run `npx -y bun test` and diff `scripts/*-manager.ts` against the reference projects |
| `did not return an artifact ID` | Notebook has no *ready* sources, or the artifact type isn't enabled for the account |

## Tests

```bash
cd test
npx -y bun install                          # dev deps only (typescript, types)
npx -y bun x tsc --noEmit                   # type-check
npx -y bun test unit                        # offline: payload shapes + decoders against recorded responses
npx -y bun test live.test.ts                # live: auth + read endpoints (skips without a session)
NOTEBOOKLM_LIVE_WRITE=1 npx -y bun test live.test.ts             # + add/delete a text source and a note
NOTEBOOKLM_LIVE_GENERATE=quiz npx -y bun test live.test.ts       # + generate one artifact end-to-end
```

Skill-level evals (prompts + assertions for the skill-creator harness) live in `test/evals.json`.
