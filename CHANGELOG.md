# Changelog

## 1.1.0 — 2026-08-28

### Fixed
- **NotebookLM host migration.** NotebookLM moved to `https://notebook.google.com` (the old
  `notebooklm.google.com` host now 301-redirects), which broke every request and the browser
  login. All requests, the CDP login flow, and session checks now go through a single
  configurable origin (`scripts/constants.ts`, override `NOTEBOOKLM_BASE_URL`); both hosts are
  accepted in notebook URLs.
- `login` validates the cached session before skipping Chrome, and the cookie map prefers
  cookies scoped to the app host over stale legacy ones (fixed a real re-login failure).
- Slide-deck PDF export no longer routes PPTX bytes to a `.pdf` path.

### Changed
- Realigned the batchexecute RPC payloads and decoder against the `notebooklm-py` reference
  (live-verified) and cross-checked with `notebooklm-sdk`: rewrote the decoder (error frames,
  status envelopes, method-id drift detection, null results) and the artifact/source/note/chat/
  research builders and parsers. Mind map is generated as a Studio artifact; data table exports
  to CSV.

### Added
- **Multi-host packaging.** Installs in Claude Code, OpenAI Codex, Cursor, and GitHub Copilot CLI
  from the same repository:
  - `plugin.json` (repo root) — [Agent Plugins 1.0](https://agent-plugins.org/specification)
    portable manifest, read by Cursor and Copilot CLI, validated against the 1.0.0 JSON schema.
  - `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json` — OpenAI Codex manifest and
    marketplace catalog.
  - Existing `.claude-plugin/` files are unchanged apart from the version bump; the plugin keeps
    `strict:true` + skill auto-discovery.
- `scripts/check-manifests.sh` — release gate. Fails if `name`, `version`, or `description` differ
  across the host manifests, if `plugin.json` contains fields outside the Agent Plugins 1.0 closed
  schema, or if the install wiring drifts; also runs `claude plugin validate` and the Agent Plugins
  1.0.0 schema check.
- `artifacts list` and `notebooks remote` commands.
- Repo-root `test/` harness: offline unit tests (inline real-derived samples in `test/samples.ts`)
  + `live.test.ts` against the real service; `test/evals.json`.
- `CHANGELOG.md` (this file).

## 1.0.0

- Initial release: chat, artifact generation (slides, audio, video, mind maps, quizzes,
  flashcards, infographics, reports, data tables), source management, research, and notes for
  Google NotebookLM via the batchexecute protocol.
