import { RPCClient } from './rpc-client.js';
import { RPC } from './rpc-types.js';

export interface NoteInfo {
  id: string;
  title: string;
  content: string;
  /** True when the content is a mind-map JSON tree rather than prose. */
  isMindMap?: boolean;
}

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------
// GET_NOTES_AND_MIND_MAPS → [[row, ...], [timestamp]]  (or a bare row list)
// Row shapes seen in the wild:
//   [id, [id, content, metadata, null, title]]      historical
//   [null, [id, content, metadata, null, title]]    current web client
//   [id, null, 2]                                   soft-deleted (skip)
// CREATE_NOTE → [[id, "", metadata, null, "New Note"]]

const INNER_ID = 0;
const INNER_CONTENT = 1;
const INNER_TITLE = 4;
const DELETED_SENTINEL = 2;

export function looksLikeMindMap(content: string): boolean {
  return content.includes('"children":') || content.includes('"nodes":');
}

export function parseNoteRow(item: unknown): NoteInfo | null {
  if (!Array.isArray(item) || item.length < 2) return null;
  if (item[1] === null && item[2] === DELETED_SENTINEL) return null;

  const inner = Array.isArray(item[1]) ? (item[1] as unknown[]) : Array.isArray(item[0]) ? (item[0] as unknown[]) : null;
  if (inner) {
    const id = typeof inner[INNER_ID] === 'string' ? inner[INNER_ID] : typeof item[0] === 'string' ? item[0] : null;
    if (!id) return null;
    const content = typeof inner[INNER_CONTENT] === 'string' ? inner[INNER_CONTENT] : '';
    const title = typeof inner[INNER_TITLE] === 'string' ? inner[INNER_TITLE] : '';
    return { id, title, content, isMindMap: looksLikeMindMap(content) };
  }

  // Flat legacy shape: [id, content, metadata, null, title]
  if (typeof item[0] === 'string' && item[0].length >= 8) {
    const content = typeof item[1] === 'string' ? item[1] : '';
    const title = typeof item[4] === 'string' ? item[4] : '';
    return { id: item[0], title, content, isMindMap: looksLikeMindMap(content) };
  }
  return null;
}

export function parseNotesList(data: unknown): NoteInfo[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  const first = data[0];
  // A row starts with a string id (or null in the current wrapper shape); a
  // container starts with a row (an array). `[[row, ...], [timestamp]]` → rows at data[0].
  const isRow = Array.isArray(first) && (typeof first[0] === 'string' || first[0] === null);
  const container = isRow ? data : Array.isArray(first) ? first : [];
  return (container as unknown[]).map(parseNoteRow).filter((n): n is NoteInfo => n !== null);
}

export function extractCreatedNoteId(response: unknown): string {
  const row = Array.isArray(response) ? response[0] : undefined;
  const id = Array.isArray(row) && typeof row[0] === 'string' ? row[0] : typeof row === 'string' ? row : null;
  if (!id) throw new Error('CREATE_NOTE did not return a note ID');
  return id;
}

// ---------------------------------------------------------------------------
// Param builders (exported for tests)
// ---------------------------------------------------------------------------

export const buildCreateNoteParams = (notebookId: string, title: string): unknown[] => [notebookId, '', [1], null, title || 'New Note'];
export const buildUpdateNoteParams = (notebookId: string, noteId: string, content: string, title: string): unknown[] => [
  notebookId,
  noteId,
  [[[content, title || 'New Note', [], 0]]],
];
export const buildDeleteNoteParams = (notebookId: string, noteId: string): unknown[] => [notebookId, null, [noteId]];

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * CREATE_NOTE ignores content — it creates an empty "New Note" and returns its id —
 * so creating a note with content is a two-step create + update.
 */
export async function createNote(rpc: RPCClient, notebookId: string, title: string, content: string): Promise<NoteInfo> {
  const response = await rpc.execute(RPC.CREATE_NOTE, buildCreateNoteParams(notebookId, title), `/notebook/${notebookId}`);
  const noteId = extractCreatedNoteId(response);
  await rpc.execute(RPC.UPDATE_NOTE, buildUpdateNoteParams(notebookId, noteId, content, title), `/notebook/${notebookId}`);
  return { id: noteId, title, content };
}

export async function updateNote(rpc: RPCClient, notebookId: string, noteId: string, title: string, content: string): Promise<NoteInfo> {
  await rpc.execute(RPC.UPDATE_NOTE, buildUpdateNoteParams(notebookId, noteId, content, title), `/notebook/${notebookId}`);
  return { id: noteId, title, content };
}

export async function deleteNote(rpc: RPCClient, notebookId: string, noteId: string): Promise<void> {
  await rpc.execute(RPC.DELETE_NOTE, buildDeleteNoteParams(notebookId, noteId), `/notebook/${notebookId}`);
}

export async function listNotes(rpc: RPCClient, notebookId: string): Promise<NoteInfo[]> {
  const response = await rpc.execute(RPC.GET_NOTES_AND_MIND_MAPS, [notebookId], `/notebook/${notebookId}`);
  return parseNotesList(response);
}
