import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { RPCClient } from './rpc-client.js';
import { RPC, SOURCE_STATUS, SOURCE_TYPE_CODE, templateBlock } from './rpc-types.js';
import { NOTEBOOKLM_ORIGIN, UPLOAD_URL, USER_AGENT } from './constants.js';
import { formatCookieHeader } from './cookie-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceInfo {
  id: string;
  title: string;
  type: string;
  url?: string;
  status: 'processing' | 'ready' | 'error';
  createdAt?: string;
  wordCount?: number;
}

// ---------------------------------------------------------------------------
// Source row parsing
// ---------------------------------------------------------------------------
// Source row (GET_NOTEBOOK → data[0][1][*], ADD_SOURCE → data[0][*]):
//   [0] id envelope: "id" | ["id"] | [null, true, ["id"]] (drive-backed)
//   [1] title
//   [2] metadata: [docsMeta, wordCount, [createdSec, nanos], [revision], typeCode, [youtubeUrl], ?, [url], ...]
//   [3] settings: [null, statusCode]

function extractSourceId(envelope: unknown): string | null {
  if (typeof envelope === 'string') return envelope;
  if (!Array.isArray(envelope)) return null;
  if (typeof envelope[0] === 'string') return envelope[0];
  const deep = envelope[2];
  if (Array.isArray(deep) && typeof deep[0] === 'string') return deep[0];
  return null;
}

export function resolveSourceStatus(code: unknown): SourceInfo['status'] {
  switch (code) {
    case SOURCE_STATUS.READY:
      return 'ready';
    case SOURCE_STATUS.ERROR:
      return 'error';
    default:
      return 'processing';
  }
}

/** Parses one source row into SourceInfo (null if it doesn't look like a source row). */
export function parseSourceRow(entry: unknown): SourceInfo | null {
  if (!Array.isArray(entry)) return null;
  const id = extractSourceId(entry[0]);
  if (!id || id.length < 8) return null;

  const meta = Array.isArray(entry[2]) ? (entry[2] as unknown[]) : [];
  const settings = Array.isArray(entry[3]) ? (entry[3] as unknown[]) : [];

  const typeCode = typeof meta[4] === 'number' ? (meta[4] as number) : 0;
  const urlBlock = meta[7];
  const ytBlock = meta[5];
  let url: string | undefined;
  if (Array.isArray(urlBlock) && typeof urlBlock[0] === 'string') url = urlBlock[0];
  else if (Array.isArray(ytBlock) && typeof ytBlock[0] === 'string') url = ytBlock[0];

  const ts = meta[2];
  const createdAt =
    Array.isArray(ts) && typeof ts[0] === 'number' ? new Date(ts[0] * 1000).toISOString() : undefined;

  return {
    id,
    title: typeof entry[1] === 'string' ? entry[1] : id,
    type: SOURCE_TYPE_CODE[typeCode] ?? 'unknown',
    url,
    status: resolveSourceStatus(settings[1]),
    createdAt,
    wordCount: typeof meta[1] === 'number' ? (meta[1] as number) : undefined,
  };
}

/** Extracts source rows from a GET_NOTEBOOK response (`data[0][1]`). */
export function parseNotebookSources(data: unknown): SourceInfo[] {
  const notebook = Array.isArray(data) ? data[0] : undefined;
  const rows = Array.isArray(notebook) && Array.isArray(notebook[1]) ? (notebook[1] as unknown[]) : [];
  return rows.map(parseSourceRow).filter((s): s is SourceInfo => s !== null);
}

/** Extracts the newly created rows from an ADD_SOURCE / ADD_SOURCE_FILE response. */
export function parseAddedSources(data: unknown): SourceInfo[] {
  if (!Array.isArray(data)) return [];
  const direct = data.map(parseSourceRow).filter((s): s is SourceInfo => s !== null);
  if (direct.length) return direct;
  const nested = Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
  return nested.map(parseSourceRow).filter((s): s is SourceInfo => s !== null);
}

// ---------------------------------------------------------------------------
// Param builders (exported for tests)
// ---------------------------------------------------------------------------

export function urlSourceSpec(url: string): unknown[] {
  return [null, null, [url], null, null, null, null, null, null, null, 1];
}

export function youtubeSourceSpec(url: string): unknown[] {
  return [null, null, null, null, null, null, null, [url], null, null, 1];
}

export function textSourceSpec(title: string, content: string): unknown[] {
  return [null, [title, content], null, 2, null, null, null, null, null, null, 1];
}

export function buildAddSourceParams(specs: unknown[][], notebookId: string): unknown[] {
  return [specs, notebookId, templateBlock()];
}

export function buildRegisterFileParams(fileName: string, notebookId: string): unknown[] {
  return [[[fileName]], notebookId, templateBlock()];
}

export function buildGetNotebookParams(notebookId: string): unknown[] {
  return [notebookId, null, templateBlock(), null, 0];
}

export function isYouTubeUrl(url: string): boolean {
  return /(^|\.)youtube\.com\//.test(url) || url.includes('youtu.be/');
}

// ---------------------------------------------------------------------------
// Add sources
// ---------------------------------------------------------------------------

export async function addSourceUrl(rpc: RPCClient, notebookId: string, url: string): Promise<SourceInfo[]> {
  const spec = isYouTubeUrl(url) ? youtubeSourceSpec(url) : urlSourceSpec(url);
  const res = await rpc.execute(RPC.ADD_SOURCE, buildAddSourceParams([spec], notebookId), `/notebook/${notebookId}`);
  return parseAddedSources(res);
}

export async function addSourceYouTube(rpc: RPCClient, notebookId: string, url: string): Promise<SourceInfo[]> {
  const full = /^https?:\/\//.test(url) ? url : `https://www.youtube.com/watch?v=${url}`;
  const res = await rpc.execute(RPC.ADD_SOURCE, buildAddSourceParams([youtubeSourceSpec(full)], notebookId), `/notebook/${notebookId}`);
  return parseAddedSources(res);
}

export async function addSourceText(rpc: RPCClient, notebookId: string, title: string, content: string): Promise<SourceInfo[]> {
  const res = await rpc.execute(RPC.ADD_SOURCE, buildAddSourceParams([textSourceSpec(title, content)], notebookId), `/notebook/${notebookId}`);
  return parseAddedSources(res);
}

/**
 * Adds a local file as a source via the 3-step resumable upload:
 *   1. ADD_SOURCE_FILE registers the filename and returns the new source id.
 *   2. POST /upload/_/ (command: start) opens a session; the session URL comes back in x-goog-upload-url.
 *   3. POST the bytes to the session URL (command: upload, finalize).
 */
export async function addSourceFile(
  rpc: RPCClient,
  notebookId: string,
  filePath: string,
  cookieMap: Record<string, string>,
): Promise<{ sourceId: string; fileName: string }> {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const fileSize = (await stat(resolvedPath)).size;
  const fileBuffer = await readFile(resolvedPath);

  const registerResponse = await rpc.execute(
    RPC.ADD_SOURCE_FILE,
    buildRegisterFileParams(fileName, notebookId),
    `/notebook/${notebookId}`,
  );
  const registered = parseAddedSources(registerResponse);
  const sourceId = registered[0]?.id ?? firstString(registerResponse);
  if (!sourceId) {
    throw new Error('ADD_SOURCE_FILE (o4cbdc) did not return a source ID for the upload.');
  }

  const cookieHeader = formatCookieHeader(cookieMap);
  // Origin/Referer must name the host the request is actually sent to — Google's
  // origin-bound checks reject a mismatch between the two personal hosts.
  const headersFor = (url: string) => {
    const origin = new URL(url).origin;
    return {
      'Cookie': cookieHeader,
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'x-goog-authuser': '0',
      'origin': origin,
      'referer': `${origin}/`,
    };
  };

  const initiate = await fetch(`${UPLOAD_URL}?authuser=0`, {
    method: 'POST',
    headers: {
      ...headersFor(UPLOAD_URL),
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(fileSize),
      'x-goog-upload-header-content-type': guessMimeType(fileName),
    },
    body: JSON.stringify({ PROJECT_ID: notebookId, SOURCE_NAME: fileName, SOURCE_ID: sourceId }),
  });
  if (!initiate.ok) {
    const errorText = await initiate.text().catch(() => '');
    throw new Error(`File upload initiation failed: ${initiate.status} ${initiate.statusText}${errorText ? `\n${errorText.slice(0, 500)}` : ''}`);
  }
  const sessionUrl = initiate.headers.get('x-goog-upload-url');
  if (!sessionUrl) throw new Error('File upload initiation did not return an x-goog-upload-url header.');
  const sessionHost = new URL(sessionUrl).hostname;
  if (sessionHost !== new URL(NOTEBOOKLM_ORIGIN).hostname && !sessionHost.endsWith('.google.com')) {
    throw new Error(`Refusing to upload to unexpected host: ${sessionUrl}`);
  }

  const upload = await fetch(sessionUrl, {
    method: 'POST',
    headers: {
      ...headersFor(sessionUrl),
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-offset': '0',
    },
    body: fileBuffer,
  });
  if (!upload.ok) {
    const errorText = await upload.text().catch(() => '');
    throw new Error(`File upload failed: ${upload.status} ${upload.statusText}${errorText ? `\n${errorText.slice(0, 500)}` : ''}`);
  }
  return { sourceId, fileName };
}

/** MIME type for the resumable-upload start header (NotebookLM sniffs content anyway). */
export function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.epub': 'application/epub+zip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
  };
  return map[ext] ?? 'application/octet-stream';
}

function firstString(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    for (const item of data) {
      const s = firstString(item);
      if (s) return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// List / delete / wait
// ---------------------------------------------------------------------------

export async function listSources(rpc: RPCClient, notebookId: string): Promise<SourceInfo[]> {
  const response = await rpc.execute(RPC.GET_NOTEBOOK, buildGetNotebookParams(notebookId), `/notebook/${notebookId}`);
  if (!Array.isArray(response)) throw new Error('GET_NOTEBOOK returned an unexpected response format');
  return parseNotebookSources(response);
}

export async function deleteSource(rpc: RPCClient, notebookId: string, sourceId: string): Promise<void> {
  await rpc.execute(RPC.DELETE_SOURCE, [[[sourceId]]], `/notebook/${notebookId}`);
}

/** Polls until every given source is ready (or errored). */
export async function waitForSources(
  rpc: RPCClient,
  notebookId: string,
  sourceIds: string[],
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<SourceInfo[]> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const start = Date.now();
  let interval = options?.intervalMs ?? 1500;
  while (Date.now() - start < timeoutMs) {
    const sources = await listSources(rpc, notebookId);
    const mine = sources.filter((s) => sourceIds.includes(s.id));
    if (mine.length === sourceIds.length && mine.every((s) => s.status !== 'processing')) return mine;
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 10_000);
  }
  throw new Error(`Timed out waiting for sources to finish processing: ${sourceIds.join(', ')}`);
}
