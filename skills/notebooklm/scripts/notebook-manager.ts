import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LibraryFile, NotebookInfo } from './types.js';
import { resolveLibraryPath } from './paths.js';

const EMPTY_LIBRARY: LibraryFile = {
  version: 1,
  notebooks: [],
};

/**
 * Loads the notebook library from disk.
 * Returns an empty library if the file does not exist or is malformed.
 */
export async function loadLibrary(): Promise<LibraryFile> {
  const libraryPath = resolveLibraryPath();
  try {
    const raw = await readFile(libraryPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LibraryFile>;
    if (parsed.version === 1 && Array.isArray(parsed.notebooks)) {
      return parsed as LibraryFile;
    }
    return { ...EMPTY_LIBRARY };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { ...EMPTY_LIBRARY };
    return { ...EMPTY_LIBRARY };
  }
}

/**
 * Saves the notebook library to disk with pretty-printed JSON.
 */
export async function saveLibrary(library: LibraryFile): Promise<void> {
  const libraryPath = resolveLibraryPath();
  await mkdir(path.dirname(libraryPath), { recursive: true });
  await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`, 'utf8');
}

/**
 * Adds a notebook to the library. If a notebook with the same ID already
 * exists, it is updated with the new information.
 */
export async function addNotebook(
  info: Omit<NotebookInfo, 'addedAt' | 'useCount'>,
): Promise<void> {
  const library = await loadLibrary();
  const existing = library.notebooks.findIndex((n) => n.id === info.id);

  const entry: NotebookInfo = {
    ...info,
    addedAt: new Date().toISOString(),
    useCount: 0,
  };

  if (existing >= 0) {
    // Preserve addedAt and useCount from the existing entry
    entry.addedAt = library.notebooks[existing].addedAt;
    entry.useCount = library.notebooks[existing].useCount;
    library.notebooks[existing] = entry;
  } else {
    library.notebooks.push(entry);
    // Auto-activate on first insert only
    if (library.notebooks.length === 1) {
      library.activeNotebookId = info.id;
    }
  }

  await saveLibrary(library);
}

/**
 * Removes a notebook from the library by ID.
 */
export async function removeNotebook(id: string): Promise<void> {
  const library = await loadLibrary();
  const before = library.notebooks.length;
  library.notebooks = library.notebooks.filter((n) => n.id !== id);

  if (library.notebooks.length === before) {
    throw new Error(`Notebook "${id}" not found in library`);
  }

  // Clear active if removed
  if (library.activeNotebookId === id) {
    library.activeNotebookId = library.notebooks[0]?.id;
  }

  await saveLibrary(library);
}

/**
 * Returns all notebooks in the library.
 */
export async function listNotebooks(): Promise<NotebookInfo[]> {
  const library = await loadLibrary();
  return library.notebooks;
}

/**
 * Searches notebooks by name, description, or topics.
 * Performs a case-insensitive substring match.
 */
export async function searchNotebooks(query: string): Promise<NotebookInfo[]> {
  const library = await loadLibrary();
  const lower = query.toLowerCase();
  return library.notebooks.filter((n) => {
    if (n.name.toLowerCase().includes(lower)) return true;
    if (n.description?.toLowerCase().includes(lower)) return true;
    if (n.topics?.some((t) => t.toLowerCase().includes(lower))) return true;
    return false;
  });
}

/**
 * Sets the active notebook by ID. The active notebook is used as the
 * default when no --notebook flag is specified in CLI commands.
 */
export async function setActiveNotebook(id: string): Promise<void> {
  const library = await loadLibrary();
  const notebook = library.notebooks.find((n) => n.id === id);
  if (!notebook) {
    throw new Error(`Notebook "${id}" not found in library`);
  }
  library.activeNotebookId = id;
  await saveLibrary(library);
}

/**
 * Returns the currently active notebook, or null if none is set.
 */
export async function getActiveNotebook(): Promise<NotebookInfo | null> {
  const library = await loadLibrary();
  if (!library.activeNotebookId) return null;
  return library.notebooks.find((n) => n.id === library.activeNotebookId) ?? null;
}

/**
 * Records a usage event for a notebook (increments useCount, updates lastUsed).
 */
export async function recordUsage(id: string): Promise<void> {
  const library = await loadLibrary();
  const notebook = library.notebooks.find((n) => n.id === id);
  if (!notebook) return; // silently ignore missing notebooks
  notebook.useCount += 1;
  notebook.lastUsed = new Date().toISOString();
  await saveLibrary(library);
}

/**
 * Extracts a notebook ID from a full NotebookLM URL or returns the input
 * if it already looks like a bare ID.
 *
 * Supported URL formats:
 *   https://notebooklm.google.com/notebook/NOTEBOOK_ID
 *   https://notebooklm.google.com/notebook/NOTEBOOK_ID?...
 *   https://notebooklm.google.com/notebook/NOTEBOOK_ID/...
 */
export function extractNotebookId(urlOrId: string): string {
  const trimmed = urlOrId.trim();

  // If it looks like a URL, parse it
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split('/').filter(Boolean);
      const notebookIdx = segments.indexOf('notebook');
      if (notebookIdx >= 0 && notebookIdx + 1 < segments.length) {
        return segments[notebookIdx + 1];
      }
    } catch {
      // Fall through to return as-is
    }
  }

  // Already a bare ID
  return trimmed;
}
