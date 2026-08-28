import { formatCookieHeader } from './cookie-store.js';
import { collectEnvelopes, parseChunkedPayloads, RPCClient } from './rpc-client.js';
import { RPC } from './rpc-types.js';
import { CHAT_STREAM_URL, NOTEBOOKLM_ORIGIN, USER_AGENT, notebookUrl } from './constants.js';
import type { LogFn } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatOptions {
  notebookId: string;
  question: string;
  sourceIds: string[];
  /** Server conversation id (from a previous answer) to continue a thread. */
  conversationId?: string;
  /** Prior turns, replayed so the model has context (oldest first). */
  history?: ChatTurn[];
  cookieMap: Record<string, string>;
  csrfToken: string;
  sessionId?: string;
  /** Build label; the server doesn't validate it but the web client always sends one. */
  bl?: string;
  log?: LogFn;
}

export interface ChatCitation {
  index: number;
  sourceId?: string;
  text?: string;
}

export interface ChatResponse {
  answer: string;
  conversationId: string;
  citations: ChatCitation[];
}

const DEFAULT_BL = 'boq_labs-tailwind-frontend_20260802.02_p0';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Request building (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Wire params for GenerateFreeFormStreamed:
 *   [ [[[sid]],...], question, history, [2,null,[1],[1]], conversationId, null, null, notebookId, 1 ]
 * History entries alternate [answer, null, 2] / [query, null, 1].
 */
export function buildChatParams(opts: {
  sourceIds: string[];
  question: string;
  history?: ChatTurn[];
  conversationId?: string | null;
  notebookId: string;
}): unknown[] {
  const history = (opts.history ?? []).map((t) => [t.text, null, t.role === 'user' ? 1 : 2]);
  return [
    opts.sourceIds.map((id) => [[id]]),
    opts.question,
    history.length ? history : null,
    [2, null, [1], [1]],
    opts.conversationId ?? null,
    null,
    null,
    opts.notebookId,
    1,
  ];
}

/** The chat endpoint uses `[null, "<params json>"]` — not the batchexecute triple envelope. */
export function buildChatBody(params: unknown[], csrfToken: string): string {
  const parts = [`f.req=${encodeURIComponent(JSON.stringify([null, JSON.stringify(params)]))}`];
  if (csrfToken) parts.push(`at=${encodeURIComponent(csrfToken)}`);
  return parts.join('&') + '&';
}

// ---------------------------------------------------------------------------
// Response parsing (exported for tests)
// ---------------------------------------------------------------------------
// Each streamed chunk decodes to inner = [answerRow, ..., isFinalResponse@4].
// answerRow = [text, null, [convId, turnId, ts], emptyReason, typeBlock]
// typeBlock = [refs, null, null, citations, marker] — marker === 1 means "this is the answer"
// citation  = [[chunkIds], detail]; detail[4] = fragments, detail[5] = [[..., sourceId]]

function findUuid(node: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof node === 'string' && UUID_RE.test(node)) return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUuid(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function collectStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof node === 'string' && node.length > 0 && !UUID_RE.test(node)) out.push(node);
  if (Array.isArray(node)) for (const item of node) collectStrings(item, out, depth + 1);
}

export function parseCitations(answerRow: unknown[], knownSourceIds: string[] = []): ChatCitation[] {
  const typeBlock = answerRow[4];
  const raw = Array.isArray(typeBlock) ? typeBlock[3] : undefined;
  if (!Array.isArray(raw)) return [];
  const known = new Set(knownSourceIds);
  const citations: ChatCitation[] = [];
  raw.forEach((cite, i) => {
    if (!Array.isArray(cite)) return;
    const detail = Array.isArray(cite[1]) ? (cite[1] as unknown[]) : cite;
    let sourceId = findUuid(detail[5]);
    if (!sourceId || (known.size && !known.has(sourceId))) {
      const all: string[] = [];
      (function walk(n: unknown, d: number) {
        if (d > 6) return;
        if (typeof n === 'string' && UUID_RE.test(n)) all.push(n);
        if (Array.isArray(n)) for (const x of n) walk(x, d + 1);
      })(detail, 0);
      sourceId = all.find((u) => known.has(u)) ?? sourceId ?? all[0];
    }
    const fragments: string[] = [];
    collectStrings(detail[4], fragments);
    citations.push({ index: i + 1, sourceId, text: fragments.join(' ').trim() || undefined });
  });
  return citations;
}

export interface ParsedChat {
  answer: string;
  conversationId?: string;
  citations: ChatCitation[];
  parseableChunks: number;
}

export function parseChatResponse(text: string, knownSourceIds: string[] = []): ParsedChat {
  const envelopes = collectEnvelopes(parseChunkedPayloads(text));
  let parseable = 0;
  let finalMarked: unknown[] | null = null;
  let bestMarked: unknown[] | null = null;
  let bestUnmarked: unknown[] | null = null;
  let conversationId: string | undefined;

  for (const env of envelopes) {
    if (env[0] !== 'wrb.fr' || typeof env[2] !== 'string') {
      if (env[0] === 'wrb.fr' && Array.isArray(env[5]) && JSON.stringify(env[5]).includes('UserDisplayableError')) {
        throw new Error('NotebookLM rejected the chat request (daily chat quota reached or feature unavailable).');
      }
      continue;
    }
    let inner: unknown;
    try {
      inner = JSON.parse(env[2]);
    } catch {
      continue;
    }
    if (!Array.isArray(inner)) continue;
    parseable++;
    const row = inner[0];
    if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length === 0) continue;

    const convBlock = row[2];
    if (Array.isArray(convBlock) && typeof convBlock[0] === 'string') conversationId = convBlock[0];

    const typeBlock = row[4];
    const isAnswer = Array.isArray(typeBlock) && typeBlock[typeBlock.length - 1] === 1;
    const isFinal = inner[4] === true;

    if (isAnswer) {
      if (isFinal) finalMarked = row;
      if (!bestMarked || (row[0] as string).length > (bestMarked[0] as string).length) bestMarked = row;
    } else if (!bestUnmarked || (row[0] as string).length > (bestUnmarked[0] as string).length) {
      bestUnmarked = row;
    }
  }

  if (parseable === 0) {
    throw new Error('Chat response contained no parseable chunks — the session may have expired (try "login --force") or the wire format changed.');
  }
  const chosen = finalMarked ?? bestMarked ?? bestUnmarked;
  return {
    answer: chosen ? (chosen[0] as string) : '',
    conversationId,
    citations: chosen ? parseCitations(chosen, knownSourceIds) : [],
    parseableChunks: parseable,
  };
}

// ---------------------------------------------------------------------------
// Main chat function
// ---------------------------------------------------------------------------

let reqidCounter = 100000;

/**
 * Sends a question to the notebook's AI via the GenerateFreeFormStreamed endpoint
 * (the same one the web UI uses — NOT batchexecute).
 */
export async function chat(options: ChatOptions): Promise<ChatResponse> {
  const { notebookId, question, sourceIds, cookieMap, csrfToken, sessionId, log } = options;

  const params = buildChatParams({
    sourceIds,
    question,
    history: options.history,
    conversationId: options.conversationId ?? null,
    notebookId,
  });

  const url = new URL(CHAT_STREAM_URL);
  url.searchParams.set('bl', options.bl ?? process.env.NOTEBOOKLM_BL ?? DEFAULT_BL);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('_reqid', String((reqidCounter += 100000)));
  url.searchParams.set('rt', 'c');
  if (sessionId) url.searchParams.set('f.sid', sessionId);

  log?.(`[notebooklm] Sending chat request to notebook ${notebookId}`);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': formatCookieHeader(cookieMap),
      'User-Agent': USER_AGENT,
      'origin': NOTEBOOKLM_ORIGIN,
      'referer': notebookUrl(notebookId),
      'x-same-domain': '1',
    },
    body: buildChatBody(params, csrfToken),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}${errorText ? `\n${errorText.slice(0, 500)}` : ''}`);
  }

  const responseText = await response.text();
  if (!responseText.trim()) {
    throw new Error('Chat request returned an empty response. The session may have expired — try running "login --force".');
  }

  const parsed = parseChatResponse(responseText, sourceIds);
  if (!parsed.answer) {
    throw new Error('Chat response did not contain an answer. The AI may not have generated a response.');
  }

  log?.(`[notebooklm] Chat response received (${parsed.answer.length} chars, ${parsed.citations.length} citations)`);

  return {
    answer: parsed.answer,
    conversationId: parsed.conversationId ?? options.conversationId ?? '',
    citations: parsed.citations,
  };
}

/**
 * Returns the notebook's most recent server-side conversation id (GET_LAST_CONVERSATION_ID).
 * The id embedded in the streamed answer is per-turn; this is the one to continue a thread with.
 */
export async function getLastConversationId(rpc: RPCClient, notebookId: string): Promise<string | undefined> {
  const res = await rpc.execute(RPC.GET_LAST_CONVERSATION_ID, [[], null, notebookId, 1], `/notebook/${notebookId}`);
  return findUuid(res);
}
