import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { RPCClient } from './rpc-client.js';
import { RPC } from './rpc-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceInfo {
  id: string;
  title: string;
  type: 'pdf' | 'web' | 'youtube' | 'text' | 'google_docs' | 'unknown';
  url?: string;
  status: 'processing' | 'ready' | 'error';
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Source type detection
// ---------------------------------------------------------------------------

/**
 * Infers the source type from the deeply nested metadata in a source entry.
 *
 * Source entries contain type indicators at various positions in the nested
 * arrays. We check for known patterns: URL presence (web), YouTube markers,
 * text/paste markers, Google Docs references, and PDF upload markers.
 */
function inferSourceType(entry: unknown[]): SourceInfo['type'] {
  const json = JSON.stringify(entry);

  // YouTube sources contain youtube.com or youtu.be URLs
  if (json.includes('youtube.com') || json.includes('youtu.be')) return 'youtube';

  // Google Docs sources reference docs.google.com
  if (json.includes('docs.google.com')) return 'google_docs';

  // Web sources contain http:// or https:// URLs (but not Google Docs / YouTube)
  if (json.includes('http://') || json.includes('https://')) return 'web';

  // Text/paste sources typically have the content embedded directly
  // They have a specific structure with [null, [title, content], ...]
  try {
    if (Array.isArray(entry[2]) && Array.isArray((entry[2] as unknown[])[1])) {
      return 'text';
    }
  } catch {
    // ignore
  }

  // PDF / file uploads are the fallback if no URL pattern matches
  // Check for file-related markers
  if (json.includes('.pdf') || json.includes('application/pdf')) return 'pdf';

  return 'unknown';
}

/**
 * Extracts a URL from a source entry if one exists.
 */
function extractSourceUrl(entry: unknown[]): string | undefined {
  function walk(node: unknown, depth: number): string | undefined {
    if (depth > 10) return undefined;
    if (typeof node === 'string' && (node.startsWith('http://') || node.startsWith('https://'))) {
      // Skip Google internal URLs
      if (node.includes('lh3.google') || node.includes('googleusercontent.com')) return undefined;
      return node;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  return walk(entry, 0);
}

/**
 * Resolves a numeric status code to a human-readable status string.
 *
 * Status codes observed in source entries:
 *   1 = processing (still being ingested)
 *   2 = ready (fully processed)
 *   3+ = error states
 */
function resolveSourceStatus(code: number | null | undefined): SourceInfo['status'] {
  if (code === null || code === undefined) return 'processing';
  if (code === 2 || code === 3) return 'ready';
  if (code >= 4) return 'error';
  return 'processing';
}

// ---------------------------------------------------------------------------
// Add sources
// ---------------------------------------------------------------------------

/**
 * Adds a web URL as a source to a notebook.
 *
 * @param rpc  Initialized RPCClient instance
 * @param notebookId  The notebook ID to add the source to
 * @param url  The web URL to add
 * @returns The raw RPC response
 */
export async function addSourceUrl(
  rpc: RPCClient,
  notebookId: string,
  url: string,
): Promise<unknown> {
  const params = [
    [[null, null, [url], null, null, null, null, null]],
    notebookId,
    [2],
    null,
    null,
  ];
  return rpc.execute(RPC.ADD_SOURCE, params, `/notebook/${notebookId}`);
}

/**
 * Adds a YouTube video as a source to a notebook.
 *
 * @param rpc  Initialized RPCClient instance
 * @param notebookId  The notebook ID to add the source to
 * @param url  The YouTube video URL
 * @returns The raw RPC response
 */
export async function addSourceYouTube(
  rpc: RPCClient,
  notebookId: string,
  url: string,
): Promise<unknown> {
  const params = [
    [[null, null, null, null, null, null, null, [url], null, null, 1]],
    notebookId,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]],
  ];
  return rpc.execute(RPC.ADD_SOURCE, params, `/notebook/${notebookId}`);
}

/**
 * Adds a plain-text paste as a source to a notebook.
 *
 * @param rpc  Initialized RPCClient instance
 * @param notebookId  The notebook ID to add the source to
 * @param title  The display title for the text source
 * @param content  The text content to add
 * @returns The raw RPC response
 */
export async function addSourceText(
  rpc: RPCClient,
  notebookId: string,
  title: string,
  content: string,
): Promise<unknown> {
  const params = [
    [[null, [title, content], null, null, null, null, null, null]],
    notebookId,
    [2],
    null,
    null,
  ];
  return rpc.execute(RPC.ADD_SOURCE, params, `/notebook/${notebookId}`);
}

/**
 * Adds a file (PDF, etc.) as a source to a notebook via a 3-step upload.
 *
 * Step 1: Register file upload intent via the ADD_SOURCE_FILE RPC (o4cbdc)
 *         to get a signed upload URL.
 * Step 2: POST to the upload endpoint with x-goog-upload headers to initiate
 *         a resumable upload and get the actual upload URL.
 * Step 3: POST the file content to the upload URL.
 *
 * @param rpc  Initialized RPCClient instance
 * @param notebookId  The notebook ID to add the source to
 * @param filePath  Path to the file to upload
 * @param cookieMap  Cookie map for authenticated requests
 * @returns The raw RPC response from the final upload
 */
export async function addSourceFile(
  rpc: RPCClient,
  notebookId: string,
  filePath: string,
  cookieMap: Record<string, string>,
): Promise<unknown> {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const fileStats = await stat(resolvedPath);
  const fileSize = fileStats.size;
  const fileBuffer = await readFile(resolvedPath);

  // Determine MIME type from extension
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const mimeType = mimeTypes[ext] ?? 'application/octet-stream';

  // Step 1: Register file upload intent
  const registerParams = [notebookId, fileName, fileSize, mimeType];
  const registerResponse = await rpc.execute(RPC.ADD_SOURCE_FILE, registerParams, `/notebook/${notebookId}`);

  // Extract the upload URL from the response
  // The response typically contains a signed upload URL as a string
  let uploadUrl: string | null = null;

  function findUploadUrl(node: unknown, depth: number): void {
    if (depth > 10 || uploadUrl) return;
    if (typeof node === 'string' && node.startsWith('https://') && node.includes('upload')) {
      uploadUrl = node;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        findUploadUrl(item, depth + 1);
      }
    }
  }

  findUploadUrl(registerResponse, 0);

  if (!uploadUrl) {
    throw new Error(
      'Failed to get upload URL from file registration RPC. ' +
      'The response did not contain a valid upload endpoint.',
    );
  }

  // Step 2: Initiate resumable upload
  const { formatCookieHeader } = await import('./cookie-store.js');
  const cookieHeader = formatCookieHeader(cookieMap);

  const initiateResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(fileSize),
      'x-goog-upload-header-content-type': mimeType,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'origin': 'https://notebooklm.google.com',
      'referer': 'https://notebooklm.google.com/',
    },
    body: '',
  });

  if (!initiateResponse.ok) {
    const errorText = await initiateResponse.text().catch(() => '');
    throw new Error(
      `File upload initiation failed: ${initiateResponse.status} ${initiateResponse.statusText}` +
      (errorText ? `\n${errorText.slice(0, 500)}` : ''),
    );
  }

  // Extract the resumable upload URL from the response header
  const resumableUrl = initiateResponse.headers.get('x-goog-upload-url');
  if (!resumableUrl) {
    throw new Error(
      'File upload initiation did not return a resumable upload URL. ' +
      'The x-goog-upload-url header was missing from the response.',
    );
  }

  // Step 3: Upload file content
  const uploadResponse = await fetch(resumableUrl, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-offset': '0',
      'Content-Type': mimeType,
      'Content-Length': String(fileSize),
      'origin': 'https://notebooklm.google.com',
      'referer': 'https://notebooklm.google.com/',
    },
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text().catch(() => '');
    throw new Error(
      `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}` +
      (errorText ? `\n${errorText.slice(0, 500)}` : ''),
    );
  }

  const uploadResult = await uploadResponse.text();

  // Try to parse the upload result as JSON
  try {
    return JSON.parse(uploadResult);
  } catch {
    return uploadResult;
  }
}

// ---------------------------------------------------------------------------
// List sources
// ---------------------------------------------------------------------------

/**
 * Lists all sources in a notebook.
 *
 * Uses the GET_NOTEBOOK RPC to fetch the full notebook data, then parses
 * out the sources array. Each source entry contains the source ID, title,
 * type metadata, and processing status.
 *
 * @param rpc  Initialized RPCClient instance
 * @param notebookId  The notebook ID to list sources for
 * @returns Array of parsed source information
 */
export async function listSources(
  rpc: RPCClient,
  notebookId: string,
): Promise<SourceInfo[]> {
  const params = [notebookId, null, [2], null, 0];
  const response = await rpc.execute(RPC.GET_NOTEBOOK, params, `/notebook/${notebookId}`);

  const data = response as unknown[];
  if (!Array.isArray(data)) {
    throw new Error('GET_NOTEBOOK returned unexpected response format');
  }

  const sources: SourceInfo[] = [];

  // Sources are typically at response[0][1] as an array of source entries.
  // Each source entry structure:
  //   [[id], title, [null, wordCount, [timestamp], ...type...], [null, statusCode], ...]
  const sourceArray = extractSourceArray(data);

  for (const entry of sourceArray) {
    if (!Array.isArray(entry)) continue;

    const sourceInfo = parseSourceEntry(entry);
    if (sourceInfo) {
      sources.push(sourceInfo);
    }
  }

  return sources;
}

/**
 * Extracts the sources array from a GET_NOTEBOOK response.
 *
 * The response structure can vary, so we try multiple paths:
 *   - data[0][1] (most common)
 *   - data[0] if it's an array of source-like entries
 *   - Recursive search for arrays of source entries
 */
function extractSourceArray(data: unknown[]): unknown[][] {
  // Try data[0][1] — most common location
  if (Array.isArray(data[0])) {
    const inner = data[0] as unknown[];
    if (Array.isArray(inner[1])) {
      const candidates = inner[1] as unknown[];
      // Verify these look like source entries (arrays with nested structure)
      if (candidates.length > 0 && Array.isArray(candidates[0])) {
        return candidates as unknown[][];
      }
    }

    // Try data[0] directly if it contains source-like arrays
    if (inner.length > 0 && Array.isArray(inner[0]) && Array.isArray((inner[0] as unknown[])[0])) {
      return inner as unknown[][];
    }
  }

  // Fallback: search for arrays that look like source entries
  const found: unknown[][] = [];
  findSourceArrays(data, found, 0);
  return found;
}

/**
 * Recursively searches for source-entry-like arrays in a nested structure.
 * A source entry is an array whose first element is itself an array containing
 * a single string (the source ID).
 */
function findSourceArrays(node: unknown, result: unknown[][], depth: number): void {
  if (depth > 5 || !Array.isArray(node)) return;

  // Check if this looks like an array of source entries
  let allSourceLike = true;
  let sourceCount = 0;

  for (const item of node) {
    if (!Array.isArray(item)) {
      allSourceLike = false;
      continue;
    }
    // A source entry starts with [[sourceId]] or [sourceId]
    const first = (item as unknown[])[0];
    if (Array.isArray(first) && first.length === 1 && typeof first[0] === 'string') {
      sourceCount++;
    } else if (typeof first === 'string' && first.length > 10) {
      sourceCount++;
    }
  }

  if (allSourceLike && sourceCount > 0 && sourceCount === (node as unknown[]).length) {
    for (const item of node) {
      if (Array.isArray(item)) {
        result.push(item as unknown[]);
      }
    }
    return;
  }

  // Recurse
  for (const item of node) {
    if (Array.isArray(item)) {
      findSourceArrays(item, result, depth + 1);
    }
  }
}

/**
 * Parses a single source entry from the GET_NOTEBOOK response into a SourceInfo.
 *
 * Expected structure (approximate):
 *   [[id], title, [metadata...], [null, statusCode], ...]
 * or:
 *   [id, title, [metadata...], ...]
 */
function parseSourceEntry(entry: unknown[]): SourceInfo | null {
  if (entry.length < 2) return null;

  // Extract source ID
  let id: string | null = null;
  const first = entry[0];
  if (Array.isArray(first) && first.length >= 1 && typeof first[0] === 'string') {
    id = first[0];
  } else if (typeof first === 'string' && first.length > 5) {
    id = first;
  }

  if (!id) return null;

  // Extract title — typically at entry[1]
  let title = '';
  if (typeof entry[1] === 'string') {
    title = entry[1];
  } else if (Array.isArray(entry[1]) && typeof (entry[1] as unknown[])[0] === 'string') {
    title = (entry[1] as unknown[])[0] as string;
  }

  // If no title found, use the ID as fallback
  if (!title) {
    title = id.slice(0, 20) + '...';
  }

  // Extract status code
  let statusCode: number | null = null;
  for (let i = 2; i < entry.length; i++) {
    if (Array.isArray(entry[i])) {
      const sub = entry[i] as unknown[];
      // Status is often in [null, statusCode] patterns
      if (sub.length >= 2 && sub[0] === null && typeof sub[1] === 'number') {
        statusCode = sub[1];
        break;
      }
      // Or directly as a number in a nested array
      if (sub.length >= 1 && typeof sub[0] === 'number') {
        statusCode = sub[0];
        break;
      }
    }
  }

  // Extract creation timestamp
  let createdAt: string | undefined;
  for (let i = 2; i < entry.length; i++) {
    if (Array.isArray(entry[i])) {
      const sub = entry[i] as unknown[];
      // Timestamps are typically large numbers (Unix epoch in seconds or milliseconds)
      for (const item of sub) {
        if (Array.isArray(item)) {
          for (const ts of item as unknown[]) {
            if (typeof ts === 'number' && ts > 1_600_000_000 && ts < 2_000_000_000) {
              createdAt = new Date(ts * 1000).toISOString();
            } else if (typeof ts === 'number' && ts > 1_600_000_000_000 && ts < 2_000_000_000_000) {
              createdAt = new Date(ts).toISOString();
            }
          }
        }
      }
    }
  }

  return {
    id,
    title,
    type: inferSourceType(entry),
    url: extractSourceUrl(entry),
    status: resolveSourceStatus(statusCode),
    createdAt,
  };
}

// ---------------------------------------------------------------------------
// Delete source
// ---------------------------------------------------------------------------

/**
 * Deletes a source from a notebook.
 *
 * @param rpc  Initialized RPCClient instance
 * @param notebookId  The notebook ID containing the source
 * @param sourceId  The ID of the source to delete
 * @returns The raw RPC response
 */
export async function deleteSource(
  rpc: RPCClient,
  notebookId: string,
  sourceId: string,
): Promise<unknown> {
  const params = [notebookId, [sourceId], [2]];
  return rpc.execute(RPC.DELETE_SOURCE, params, `/notebook/${notebookId}`);
}
