import { RPCClient } from './rpc-client.js';
import { RPC } from './rpc-types.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface NoteInfo {
  id: string;
  title: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a note ID from a CREATE_NOTE response.
 * Walks the response looking for the first string that looks like a Google-style ID.
 */
function extractNoteId(response: unknown): string {
  if (typeof response === 'string' && response.length >= 8) {
    return response;
  }
  if (Array.isArray(response)) {
    // Check direct top-level string
    if (typeof response[0] === 'string' && response[0].length >= 8) {
      return response[0];
    }
    // Check nested first element
    if (Array.isArray(response[0]) && typeof response[0][0] === 'string' && response[0][0].length >= 8) {
      return response[0][0];
    }
    // Recursive fallback
    const id = findIdInNested(response);
    if (id) return id;
  }
  throw new Error('Failed to extract note ID from CREATE_NOTE response');
}

/**
 * Recursively searches a nested structure for a string that looks like a
 * Google-style ID (long alphanumeric/base64 string).
 */
function findIdInNested(data: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof data === 'string' && data.length >= 8 && /^[a-zA-Z0-9_-]+$/.test(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findIdInNested(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Parses a single note entry from a GET_NOTES_AND_MIND_MAPS response array.
 * Note entries are typically arrays with [noteId, title, content, ...] or
 * variations of that structure.
 */
function parseNoteEntry(entry: unknown): NoteInfo | null {
  if (!Array.isArray(entry)) return null;

  // Primary shape: [noteId, title, content, ...]
  const id = typeof entry[0] === 'string' && entry[0].length >= 8 ? entry[0] : null;
  if (!id) return null;

  let title = '';
  let content = '';

  if (typeof entry[1] === 'string') {
    title = entry[1];
  }
  if (typeof entry[2] === 'string') {
    content = entry[2];
  }

  // Some responses nest the note body inside a sub-array
  // e.g., [noteId, [content, title, ...], ...]
  if (Array.isArray(entry[1])) {
    const inner = entry[1];
    if (typeof inner[0] === 'string') content = inner[0];
    if (typeof inner[1] === 'string') title = inner[1];
  }

  return { id, title, content };
}

// ---------------------------------------------------------------------------
// Notes CRUD functions
// ---------------------------------------------------------------------------

/**
 * Creates a new note in a notebook with the given title and content.
 * Internally this is a two-step process: first an empty note is created,
 * then it is immediately updated with the actual title and content.
 */
export async function createNote(
  rpc: RPCClient,
  notebookId: string,
  title: string,
  content: string,
): Promise<NoteInfo> {
  // Step 1: Create an empty note
  const createParams = [notebookId, '', [1], null, 'New Note'];
  const response = await rpc.execute(RPC.CREATE_NOTE, createParams, `/notebook/${notebookId}`);
  const noteId = extractNoteId(response);

  // Step 2: Update with actual title and content
  const updateParams = [notebookId, noteId, [[[content, title, [], 0]]]];
  await rpc.execute(RPC.UPDATE_NOTE, updateParams, `/notebook/${notebookId}`);

  return { id: noteId, title, content };
}

/**
 * Updates an existing note's title and content.
 */
export async function updateNote(
  rpc: RPCClient,
  notebookId: string,
  noteId: string,
  title: string,
  content: string,
): Promise<NoteInfo> {
  const params = [notebookId, noteId, [[[content, title, [], 0]]]];
  await rpc.execute(RPC.UPDATE_NOTE, params, `/notebook/${notebookId}`);
  return { id: noteId, title, content };
}

/**
 * Deletes a note from a notebook.
 */
export async function deleteNote(
  rpc: RPCClient,
  notebookId: string,
  noteId: string,
): Promise<void> {
  const params = [notebookId, null, [noteId]];
  await rpc.execute(RPC.DELETE_NOTE, params, `/notebook/${notebookId}`);
}

/**
 * Lists all notes in a notebook by fetching the notes and mind maps response
 * and parsing out the note entries.
 */
export async function listNotes(
  rpc: RPCClient,
  notebookId: string,
): Promise<NoteInfo[]> {
  const params = [notebookId];
  const response = await rpc.execute(RPC.GET_NOTES_AND_MIND_MAPS, params, `/notebook/${notebookId}`);

  const data = response as unknown[];
  if (!Array.isArray(data)) {
    return [];
  }

  const notes: NoteInfo[] = [];

  // The response may be a flat list of note entries or nested one level deep.
  // Try parsing each top-level item as a note entry first.
  for (const item of data) {
    const note = parseNoteEntry(item);
    if (note) {
      notes.push(note);
      continue;
    }
    // If the top-level item is an array of note entries, recurse one level
    if (Array.isArray(item)) {
      for (const sub of item) {
        const subNote = parseNoteEntry(sub);
        if (subNote) {
          notes.push(subNote);
        }
      }
    }
  }

  return notes;
}
