---
name: notebooklm
description: Generate NotebookLM artifacts (slide decks, audio overviews, video overviews, mind maps, flashcards, quizzes, infographics, reports, data tables) from Google NotebookLM notebooks. Use when the user wants to create any NotebookLM output from their uploaded sources.
---

# NotebookLM Artifact Generator

Supports:
- Slide Deck generation (PDF/PPTX)
- Audio Overview (M4A -- deep dive, brief, critique, debate formats)
- Video Overview (MP4 -- classic, whiteboard, kawaii, anime, watercolor styles)
- Mind Map (PNG)
- Flashcards (HTML)
- Quiz (HTML)
- Infographic (PNG -- landscape, portrait, square)
- Report (Markdown -- briefing doc, study guide, blog post)
- Data Table (CSV / Google Sheets export)
- Notebook library management (add, list, search, activate)

## Quick start

```bash
# Authenticate first (opens Chrome for Google login)
npx -y bun scripts/main.ts login

# Add a notebook to library
npx -y bun scripts/main.ts notebooks add https://notebooklm.google.com/notebook/abc123 --name "My Research"

# Generate artifacts
npx -y bun scripts/main.ts generate slide_deck --notebook abc123 --output slides.pdf
npx -y bun scripts/main.ts generate audio --format deep_dive --length long
npx -y bun scripts/main.ts generate video --style whiteboard --output explainer.mp4
npx -y bun scripts/main.ts generate quiz --difficulty medium --quantity more --json
npx -y bun scripts/main.ts generate mind_map --output mindmap.png
npx -y bun scripts/main.ts generate infographic --orientation portrait --output info.png
npx -y bun scripts/main.ts generate report --format study_guide --output report.md
npx -y bun scripts/main.ts generate flashcards --difficulty easy --json
npx -y bun scripts/main.ts generate data_table --output data.csv
```

## Commands

### Authentication

```bash
npx -y bun scripts/main.ts login
```

First run opens Chrome for Google login. Cookies are cached for subsequent runs.

```bash
# Force cookie refresh
npx -y bun scripts/main.ts login --force
```

### Notebook Management

```bash
# List all notebooks in library
npx -y bun scripts/main.ts notebooks list

# Add a notebook by URL
npx -y bun scripts/main.ts notebooks add <url> [--name <name>] [--description <desc>] [--topics <t1,t2>]

# Remove a notebook from library
npx -y bun scripts/main.ts notebooks remove <id>

# Set active notebook (used as default for generation)
npx -y bun scripts/main.ts notebooks activate <id>

# Search notebooks
npx -y bun scripts/main.ts notebooks search <query>
```

### Artifact Generation

```bash
npx -y bun scripts/main.ts generate <type> [options]
```

Types: `slide_deck`, `audio`, `video`, `mind_map`, `flashcards`, `quiz`, `infographic`, `report`, `data_table`

## Options

### Global Options

| Option | Description |
|--------|-------------|
| `--notebook <url\|id>` | Notebook URL or library ID (defaults to active notebook) |
| `--output <path>` | Output file path (auto-named if omitted) |
| `--instructions <text>` | Custom instructions for generation |
| `--json` | Output as JSON |
| `--login` | Refresh cookies only, then exit |
| `--help`, `-h` | Show help |

### Slide Deck Options

| Option | Description |
|--------|-------------|
| `--format <type>` | Output format: `pdf` (default), `pptx` |

### Audio Overview Options

| Option | Description |
|--------|-------------|
| `--format <type>` | Audio format: `deep_dive` (default), `brief`, `critique`, `debate` |
| `--length <length>` | Duration: `short`, `default`, `long` |
| `--language <lang>` | Language code (default: `en`) |

### Video Overview Options

| Option | Description |
|--------|-------------|
| `--style <style>` | Visual style: `auto` (default), `classic`, `whiteboard`, `kawaii`, `anime`, `watercolor` |
| `--format <type>` | Video format: `explainer` (default), `brief` |

### Quiz Options

| Option | Description |
|--------|-------------|
| `--difficulty <level>` | Difficulty: `easy`, `medium` (default), `hard` |
| `--quantity <amount>` | Number of questions: `fewer`, `standard`, `more` |

### Flashcards Options

| Option | Description |
|--------|-------------|
| `--difficulty <level>` | Difficulty: `easy`, `medium` (default), `hard` |
| `--quantity <amount>` | Number of cards: `fewer`, `standard`, `more` |

### Infographic Options

| Option | Description |
|--------|-------------|
| `--orientation <type>` | Layout: `landscape` (default), `portrait`, `square` |

### Report Options

| Option | Description |
|--------|-------------|
| `--format <type>` | Report format: `briefing_doc` (default), `study_guide`, `blog_post` |

### Data Table Options

| Option | Description |
|--------|-------------|
| `--format <type>` | Output format: `csv` (default), `sheets` (Google Sheets export) |

## Artifact Types

| Type | Output Format | Description |
|------|---------------|-------------|
| `slide_deck` | PDF/PPTX | Presentation slides summarizing notebook sources |
| `audio` | M4A | Audio overview in conversation format (deep dive, brief, critique, debate) |
| `video` | MP4 | Animated video overview with visual styles |
| `mind_map` | PNG | Visual mind map of key concepts and relationships |
| `flashcards` | HTML/JSON | Study flashcards generated from source material |
| `quiz` | HTML/JSON | Multiple-choice quiz with answer key |
| `infographic` | PNG | Visual summary infographic in various orientations |
| `report` | Markdown | Written report (briefing doc, study guide, blog post) |
| `data_table` | CSV/Sheets | Structured data extracted from sources |

## Authentication

First run opens Chrome to authenticate with Google. Cookies are cached for subsequent runs. Uses CDP browser automation for the login flow, then direct batchexecute RPC calls for all operations.

```bash
# Force cookie refresh
npx -y bun scripts/main.ts login --force
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `NOTEBOOKLM_DATA_DIR` | Data directory override |
| `NOTEBOOKLM_COOKIE_PATH` | Cookie file path |
| `NOTEBOOKLM_CHROME_PROFILE_DIR` | Chrome profile directory |
| `NOTEBOOKLM_OUTPUT_DIR` | Default output directory |

## Rate Limits

NotebookLM free tier limits:

| Resource | Limit |
|----------|-------|
| Audio/video overviews | 3 per day |
| Reports/flashcards/quizzes | 10 per day |
| Daily chats | 50 |
| Total notebooks | 100 |
| Sources per notebook | 50 |

## Examples

### Generate a slide deck from a specific notebook

```bash
npx -y bun scripts/main.ts generate slide_deck \
  --notebook https://notebooklm.google.com/notebook/abc123 \
  --output presentation.pdf
```

### Create an audio deep dive with custom instructions

```bash
npx -y bun scripts/main.ts generate audio \
  --format deep_dive \
  --length long \
  --instructions "Focus on the methodology section and compare approaches"
```

### Generate a whiteboard-style video overview

```bash
npx -y bun scripts/main.ts generate video \
  --style whiteboard \
  --length medium \
  --output explainer.mp4
```

### Create a quiz and get JSON output for integration

```bash
npx -y bun scripts/main.ts generate quiz \
  --difficulty hard \
  --quantity more \
  --json > quiz_data.json
```

### Generate a portrait infographic

```bash
npx -y bun scripts/main.ts generate infographic \
  --orientation portrait \
  --instructions "Highlight the three main findings" \
  --output summary.png
```

### Export structured data as CSV

```bash
npx -y bun scripts/main.ts generate data_table \
  --format csv \
  --output extracted_data.csv
```
