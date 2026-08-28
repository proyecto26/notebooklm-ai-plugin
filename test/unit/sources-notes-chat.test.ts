import { describe, expect, test } from 'bun:test';
import { decodeBatchResponse } from '../../skills/notebooklm/scripts/rpc-client.ts';
import {
  buildAddSourceParams,
  buildGetNotebookParams,
  buildRegisterFileParams,
  isYouTubeUrl,
  parseAddedSources,
  parseNotebookSources,
  textSourceSpec,
  urlSourceSpec,
  youtubeSourceSpec,
} from '../../skills/notebooklm/scripts/source-manager.ts';
import {
  buildCreateNoteParams,
  buildDeleteNoteParams,
  buildUpdateNoteParams,
  extractCreatedNoteId,
  parseNotesList,
} from '../../skills/notebooklm/scripts/notes-manager.ts';
import { buildChatBody, buildChatParams, parseChatResponse } from '../../skills/notebooklm/scripts/chat.ts';
import { buildDeepResearchParams, buildFastResearchParams, parseResearchTasks } from '../../skills/notebooklm/scripts/research-manager.ts';
import { templateBlock } from '../../skills/notebooklm/scripts/rpc-types.ts';
import { fixture } from '../helpers.ts';

const TPL = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];

describe('source payloads', () => {
  test('template block replaces the legacy [2] tail', () => {
    expect(templateBlock()).toEqual(TPL);
    expect(buildGetNotebookParams('nb')).toEqual(['nb', null, TPL, null, 0]);
    expect(buildRegisterFileParams('a.pdf', 'nb')).toEqual([[['a.pdf']], 'nb', TPL]);
  });

  test('url / youtube / text specs are 11-element rows ending in 1', () => {
    expect(urlSourceSpec('https://x.com')).toEqual([null, null, ['https://x.com'], null, null, null, null, null, null, null, 1]);
    expect(youtubeSourceSpec('https://youtu.be/abc')).toEqual([null, null, null, null, null, null, null, ['https://youtu.be/abc'], null, null, 1]);
    expect(textSourceSpec('T', 'body')).toEqual([null, ['T', 'body'], null, 2, null, null, null, null, null, null, 1]);
    expect(buildAddSourceParams([urlSourceSpec('https://x.com')], 'nb')).toEqual([[urlSourceSpec('https://x.com')], 'nb', TPL]);
  });

  test('youtube detection', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=1')).toBe(true);
    expect(isYouTubeUrl('https://youtu.be/1')).toBe(true);
    expect(isYouTubeUrl('https://example.com/youtube.com/')).toBe(false);
  });
});

describe('source parsing (recorded fixtures)', () => {
  test('GET_NOTEBOOK → sources with id, title, type, status, url', () => {
    const sources = parseNotebookSources(decodeBatchResponse(fixture('sources_list'), 'rLM1Ne'));
    expect(sources.length).toBeGreaterThan(3);
    expect(sources[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sources[0].status).toBe('ready');
    expect(sources[0].type).toBe('web');
    expect(sources[0].url).toMatch(/^https?:\/\//);
    expect(sources[0].wordCount).toBeGreaterThan(0);
  });

  test('ADD_SOURCE → the new row', () => {
    const added = parseAddedSources(decodeBatchResponse(fixture('sources_add_url'), 'izAoDd'));
    expect(added).toHaveLength(1);
    expect(added[0].title).toContain('Wikipedia');
    expect(added[0].type).toBe('web');
  });
});

describe('notes', () => {
  test('payloads', () => {
    expect(buildCreateNoteParams('nb', 'T')).toEqual(['nb', '', [1], null, 'T']);
    expect(buildUpdateNoteParams('nb', 'n1', 'body', 'T')).toEqual(['nb', 'n1', [[['body', 'T', [], 0]]]]);
    expect(buildDeleteNoteParams('nb', 'n1')).toEqual(['nb', null, ['n1']]);
  });

  test('CREATE_NOTE response → id', () => {
    expect(extractCreatedNoteId(decodeBatchResponse(fixture('notes_delete_1'), 'CYK0Xb'))).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('GET_NOTES_AND_MIND_MAPS → notes with title/content (historical shape)', () => {
    const notes = parseNotesList(decodeBatchResponse(fixture('notes_list'), 'cFji9'));
    expect(notes).toHaveLength(1);
    expect(notes[0].title.length).toBeGreaterThan(0);
    expect(notes[0].content.length).toBeGreaterThan(100);
    expect(notes[0].isMindMap).toBe(true);
  });

  test('current web-client shape [null, [id, content, meta, null, title]] and soft-deleted rows', () => {
    const notes = parseNotesList([[[null, ['11111111-1111-1111-1111-111111111111', 'hello', [], null, 'Title']], ['22222222-2222-2222-2222-222222222222', null, 2]], [1, 2]]);
    expect(notes).toEqual([{ id: '11111111-1111-1111-1111-111111111111', title: 'Title', content: 'hello', isMindMap: false }]);
  });
});

describe('chat', () => {
  test('params and body envelope', () => {
    const params = buildChatParams({
      sourceIds: ['s1'],
      question: 'Q?',
      notebookId: 'nb',
      history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }],
      conversationId: 'c1',
    });
    expect(params).toEqual([[[['s1']]], 'Q?', [['a', null, 1], ['b', null, 2]], [2, null, [1], [1]], 'c1', null, null, 'nb', 1]);
    const body = buildChatBody(params, 'TOKEN');
    expect(body.startsWith('f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(params)])))).toBe(true);
    expect(body.endsWith('&at=TOKEN&')).toBe(true);
  });

  test('parses a recorded streamed answer, picking the marked answer chunk and its citations', () => {
    const parsed = parseChatResponse(fixture('chat_ask'));
    expect(parsed.parseableChunks).toBeGreaterThan(3);
    expect(parsed.answer.length).toBeGreaterThan(1000);
    expect(parsed.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.citations.length).toBeGreaterThan(0);
    expect(parsed.citations[0].sourceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('empty / HTML bodies are rejected with a clear message', () => {
    expect(() => parseChatResponse('<html>login</html>')).toThrow(/no parseable chunks/);
  });
});

describe('research', () => {
  test('payloads', () => {
    expect(buildFastResearchParams('q', 'nb')).toEqual([['q', 1], null, 1, 'nb']);
    expect(buildDeepResearchParams('q', 'nb')).toEqual([null, [1], ['q', 1], 5, 'nb']);
  });

  test('POLL_RESEARCH → tasks with query/status', () => {
    const tasks = parseResearchTasks(decodeBatchResponse(fixture('research_poll'), 'e3bVqc'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tasks[0].query).toBe('Python programming best practices');
    expect(tasks[0].status).toBe('in_progress');
  });
});
