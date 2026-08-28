/**
 * Live endpoint + authentication smoke tests against the real NotebookLM API.
 *
 * These hit Google with the cookies saved by `scripts/main.ts login`, so they are
 * skipped (not failed) when no valid session is available. Run with:
 *
 *   npx -y bun test tests/live.test.ts
 *
 * Env:
 *   NOTEBOOKLM_TEST_NOTEBOOK   notebook id/url to use (defaults to the active library notebook,
 *                              then to the first notebook on the account)
 *   NOTEBOOKLM_LIVE_WRITE=1    also exercise write RPCs (add/delete a text source, create/delete a note)
 *   NOTEBOOKLM_LIVE_GENERATE=<type>  also generate one artifact (e.g. quiz, flashcards, mind_map, report, data_table)
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { readCookieMapFromDisk, hasRequiredCookies } from '../skills/notebooklm/scripts/cookie-store.ts';
import { RPCClient, RPCError } from '../skills/notebooklm/scripts/rpc-client.ts';
import { RPC } from '../skills/notebooklm/scripts/rpc-types.ts';
import { NOTEBOOKLM_URL, USER_AGENT } from '../skills/notebooklm/scripts/constants.ts';
import { getActiveNotebook, extractNotebookId } from '../skills/notebooklm/scripts/notebook-manager.ts';
import { addSourceText, deleteSource, listSources, waitForSources } from '../skills/notebooklm/scripts/source-manager.ts';
import { createNote, deleteNote, listNotes } from '../skills/notebooklm/scripts/notes-manager.ts';
import { chat } from '../skills/notebooklm/scripts/chat.ts';
import { ArtifactGenerator } from '../skills/notebooklm/scripts/artifact-generator.ts';
import { pollResearch } from '../skills/notebooklm/scripts/research-manager.ts';
import type { ArtifactType } from '../skills/notebooklm/scripts/types.ts';

const cookieMap = await readCookieMapFromDisk();
let sessionOk = false;
let sessionProblem = 'no cookies on disk — run: npx -y bun scripts/main.ts login';

if (hasRequiredCookies(cookieMap)) {
  try {
    const probe = new RPCClient(cookieMap);
    await probe.init();
    sessionOk = true;
  } catch (e) {
    sessionProblem = e instanceof Error ? e.message : String(e);
  }
}

const live = sessionOk ? describe : describe.skip;
if (!sessionOk) console.warn(`[live] skipping live tests: ${sessionProblem}`);

live('NotebookLM live: authentication', () => {
  test('the app origin serves the app shell (200) with cookies, not a login redirect', async () => {
    const res = await fetch(NOTEBOOKLM_URL, {
      headers: { Cookie: Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; '), 'User-Agent': USER_AGENT },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('LabsTailwindUi');
    expect(html).toMatch(/"SNlM0e":"[^"]+"/);
    expect(html).toMatch(/"FdrFJe":"[^"]+"/);
  });

  test('RPCClient.init extracts CSRF token and session id', async () => {
    const rpc = new RPCClient(cookieMap);
    await rpc.init();
    expect(rpc.getCsrfToken().length).toBeGreaterThan(20);
    expect(rpc.getSessionId().length).toBeGreaterThan(5);
  });
});

live('NotebookLM live: read endpoints', () => {
  let rpc: RPCClient;
  let notebookId: string;

  beforeAll(async () => {
    rpc = new RPCClient(cookieMap);
    await rpc.init();
    const fromEnv = process.env.NOTEBOOKLM_TEST_NOTEBOOK;
    if (fromEnv) notebookId = extractNotebookId(fromEnv);
    else {
      const active = await getActiveNotebook();
      if (active) notebookId = active.id;
    }
  });

  test('LIST_NOTEBOOKS (wXbhsf) returns notebook rows [title, sources, id, ...]', async () => {
    const data = (await rpc.execute(RPC.LIST_NOTEBOOKS, [null, 1, null, [2]])) as unknown[][];
    expect(Array.isArray(data)).toBe(true);
    const rows = data[0] as unknown[][];
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length) {
      expect(typeof rows[0][2]).toBe('string');
      if (!notebookId) notebookId = rows[0][2] as string;
    }
  });

  test('GET_NOTEBOOK (rLM1Ne) with the template block lists sources', async () => {
    if (!notebookId) return;
    const sources = await listSources(rpc, notebookId);
    expect(Array.isArray(sources)).toBe(true);
    for (const s of sources) {
      expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(['ready', 'processing', 'error']).toContain(s.status);
    }
  });

  test('LIST_ARTIFACTS (gArtLc) decodes rows with known types', async () => {
    if (!notebookId) return;
    const rows = await new ArtifactGenerator(rpc).list(notebookId);
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(['audio', 'video', 'report', 'quiz', 'flashcards', 'mind_map', 'infographic', 'slide_deck', 'data_table']).toContain(r.type);
    }
  });

  test('GET_NOTES_AND_MIND_MAPS (cFji9) decodes', async () => {
    if (!notebookId) return;
    const notes = await listNotes(rpc, notebookId);
    expect(Array.isArray(notes)).toBe(true);
  });

  test('POLL_RESEARCH (e3bVqc) decodes (may be empty)', async () => {
    if (!notebookId) return;
    try {
      const r = await pollResearch(rpc, notebookId);
      expect(['in_progress', 'completed']).toContain(r.status);
    } catch (e) {
      // "No research tasks" is a legitimate outcome; drift/auth errors are not.
      expect(e instanceof RPCError ? e.kind : 'unknown').not.toBe('drift');
      expect(String(e)).toMatch(/No research tasks/);
    }
  });

  test('chat (GenerateFreeFormStreamed) answers a question with citations', async () => {
    if (!notebookId) return;
    const sources = (await listSources(rpc, notebookId)).filter((s) => s.status === 'ready');
    if (sources.length === 0) return;
    const res = await chat({
      notebookId,
      question: 'In one sentence, what are these sources about?',
      sourceIds: sources.map((s) => s.id),
      cookieMap,
      csrfToken: rpc.getCsrfToken(),
      sessionId: rpc.getSessionId(),
    });
    expect(res.answer.length).toBeGreaterThan(10);
  }, 120_000);
});

const writeEnabled = process.env.NOTEBOOKLM_LIVE_WRITE === '1';
(sessionOk && writeEnabled ? describe : describe.skip)('NotebookLM live: write endpoints', () => {
  let rpc: RPCClient;
  let notebookId: string;
  const created: { sourceIds: string[]; noteIds: string[] } = { sourceIds: [], noteIds: [] };

  beforeAll(async () => {
    rpc = new RPCClient(cookieMap);
    await rpc.init();
    const fromEnv = process.env.NOTEBOOKLM_TEST_NOTEBOOK;
    notebookId = fromEnv ? extractNotebookId(fromEnv) : (await getActiveNotebook())!.id;
  });

  afterAll(async () => {
    for (const id of created.sourceIds) await deleteSource(rpc, notebookId, id).catch(() => {});
    for (const id of created.noteIds) await deleteNote(rpc, notebookId, id).catch(() => {});
  });

  test('ADD_SOURCE text (izAoDd) → source becomes ready → DELETE_SOURCE (tGMBJ)', async () => {
    const added = await addSourceText(rpc, notebookId, `skill-live-test ${Date.now()}`, 'NotebookLM skill live test. The capital of France is Paris.');
    expect(added.length).toBe(1);
    created.sourceIds.push(added[0].id);
    const ready = await waitForSources(rpc, notebookId, [added[0].id], { timeoutMs: 90_000 });
    expect(ready[0].status).toBe('ready');
  }, 120_000);

  test('CREATE_NOTE + UPDATE_NOTE (CYK0Xb/cYAfTb) → note listed → DELETE_NOTE (AH0mwd)', async () => {
    const note = await createNote(rpc, notebookId, 'skill live test', 'hello from the live test');
    created.noteIds.push(note.id);
    const notes = await listNotes(rpc, notebookId);
    expect(notes.some((n) => n.id === note.id && n.content.includes('hello from the live test'))).toBe(true);
  }, 60_000);
});

const generateType = process.env.NOTEBOOKLM_LIVE_GENERATE as ArtifactType | undefined;
(sessionOk && generateType ? describe : describe.skip)(`NotebookLM live: generate ${generateType}`, () => {
  test('CREATE_ARTIFACT (R7cb6c) → poll → content/url', async () => {
    const rpc = new RPCClient(cookieMap);
    await rpc.init();
    const fromEnv = process.env.NOTEBOOKLM_TEST_NOTEBOOK;
    const notebookId = fromEnv ? extractNotebookId(fromEnv) : (await getActiveNotebook())!.id;
    const sourceIds = (await listSources(rpc, notebookId)).filter((s) => s.status === 'ready').map((s) => s.id);
    expect(sourceIds.length).toBeGreaterThan(0);
    const gen = new ArtifactGenerator(rpc);
    const result = await gen.createAndWait({ type: generateType!, notebookId, sourceIds });
    expect(result.status).toBe('completed');
    expect(Boolean(result.downloadUrl || result.content)).toBe(true);
  }, 1_500_000);
});
