import { formatCookieHeader } from './cookie-store.js';
import type { LogFn } from './types.js';

const QUERY_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatOptions {
  notebookId: string;
  question: string;
  sourceIds: string[];
  conversationId?: string;
  cookieMap: Record<string, string>;
  csrfToken: string;
  sessionId?: string;
  log?: LogFn;
}

export interface ChatResponse {
  answer: string;
  conversationId: string;
  citations: Array<{ sourceId: string; text: string }>;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses the chunked streaming response from GenerateFreeFormStreamed.
 *
 * The response format is similar to batchexecute: an anti-XSSI prefix
 * `)]}'\n` followed by alternating byte-count / JSON-payload lines.
 * We look for `wrb.fr` envelopes and extract data from them.
 */
function parseStreamedChunks(text: string): unknown[][] {
  const stripped = text.replace(/^\)\]\}'\n/, '');
  const lines = stripped.split('\n');
  const envelopes: unknown[][] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) continue;

    // Top-level may be a single envelope or an array of envelopes
    if (typeof parsed[0] === 'string' && parsed[0] === 'wrb.fr') {
      envelopes.push(parsed);
    } else {
      for (const item of parsed) {
        if (Array.isArray(item) && item[0] === 'wrb.fr') {
          envelopes.push(item);
        }
      }
    }
  }

  return envelopes;
}

/**
 * Extracts the answer text from parsed response data.
 *
 * The answer is typically a long string deeply nested in the response.
 * We find the longest non-JSON string that looks like real answer text
 * (not a UUID, URL, or internal token).
 */
function extractAnswerText(data: unknown): string {
  const candidates: string[] = [];

  function walk(node: unknown, depth: number): void {
    if (depth > 15) return;
    if (typeof node === 'string' && node.length > 20) {
      // Skip UUIDs, URLs, and short tokens
      if (/^[a-f0-9-]{36}$/.test(node)) return;
      if (node.startsWith('http://') || node.startsWith('https://')) return;
      if (/^[a-zA-Z0-9_-]+$/.test(node) && node.length < 50) return;
      candidates.push(node);
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, depth + 1);
      }
    }
  }

  walk(data, 0);

  if (candidates.length === 0) return '';

  // Return the longest candidate — it's most likely the answer
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/**
 * Extracts citations from the parsed response data.
 *
 * Citations are typically arrays containing a source ID and a text snippet.
 * We look for arrays where one element looks like a source ID and another
 * is a short text string.
 */
function extractCitations(data: unknown, knownSourceIds: string[]): Array<{ sourceId: string; text: string }> {
  const citations: Array<{ sourceId: string; text: string }> = [];
  const sourceIdSet = new Set(knownSourceIds);
  const seen = new Set<string>();

  function walk(node: unknown, depth: number): void {
    if (depth > 15) return;
    if (!Array.isArray(node)) return;

    // Look for citation-like structures: arrays containing a known source ID
    // and a text snippet
    for (const item of node) {
      if (Array.isArray(item)) {
        let foundSourceId: string | null = null;
        let foundText: string | null = null;

        for (const sub of item) {
          if (typeof sub === 'string') {
            if (sourceIdSet.has(sub)) {
              foundSourceId = sub;
            } else if (sub.length > 10 && sub.length < 500 && !sub.startsWith('http')) {
              foundText = sub;
            }
          }
          // Source ID may be nested one level deeper: [[sourceId]]
          if (Array.isArray(sub) && sub.length === 1 && typeof sub[0] === 'string' && sourceIdSet.has(sub[0])) {
            foundSourceId = sub[0];
          }
        }

        if (foundSourceId && foundText) {
          const key = `${foundSourceId}:${foundText}`;
          if (!seen.has(key)) {
            seen.add(key);
            citations.push({ sourceId: foundSourceId, text: foundText });
          }
        }

        walk(item, depth + 1);
      }
    }
  }

  walk(data, 0);
  return citations;
}

/**
 * Extracts the conversation ID from the parsed response data.
 *
 * The conversation UUID is typically a 36-character string matching
 * the UUID format (8-4-4-4-12 hex digits).
 */
function extractConversationId(data: unknown, fallback: string): string {
  function walk(node: unknown, depth: number): string | null {
    if (depth > 10) return null;
    if (typeof node === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(node)) {
      return node;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(data, 0) ?? fallback;
}

// ---------------------------------------------------------------------------
// Main chat function
// ---------------------------------------------------------------------------

/**
 * Sends a chat message to NotebookLM's AI and returns the streamed response.
 *
 * Uses the GenerateFreeFormStreamed endpoint (NOT batchexecute). This is the
 * same endpoint the web UI uses for the chat interface.
 */
export async function chat(options: ChatOptions): Promise<ChatResponse> {
  const {
    notebookId,
    question,
    sourceIds,
    cookieMap,
    csrfToken,
    sessionId,
    log,
  } = options;

  // 1. Build params array
  const conversationUuid = options.conversationId || crypto.randomUUID();
  const sourcesArray = sourceIds.map(id => [[id]]);
  const params = [
    sourcesArray,
    question,
    null,
    [2, null, [1], [1]],
    conversationUuid,
    null,
    null,
    notebookId,
    1,
  ];

  // 2. Encode body
  const paramsJson = JSON.stringify(params);
  const fReq = JSON.stringify([null, paramsJson]);
  const body = new URLSearchParams();
  body.set('f.req', fReq);
  if (csrfToken) body.set('at', csrfToken);

  // 3. Build URL with query params
  const url = new URL(QUERY_URL);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('_reqid', '100000');
  url.searchParams.set('rt', 'c');
  if (sessionId) url.searchParams.set('f.sid', sessionId);

  log?.(`[notebooklm] Sending chat request to notebook ${notebookId}`);

  // 4. POST with cookies
  const cookieHeader = formatCookieHeader(cookieMap);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Cookie': cookieHeader,
      'User-Agent': USER_AGENT,
      'origin': 'https://notebooklm.google.com',
      'referer': `https://notebooklm.google.com/notebook/${notebookId}`,
      'x-same-domain': '1',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Chat request failed: ${response.status} ${response.statusText}` +
      (errorText ? `\n${errorText.slice(0, 500)}` : ''),
    );
  }

  const responseText = await response.text();

  if (!responseText.trim()) {
    throw new Error('Chat request returned an empty response. The session may have expired — try running "login --force".');
  }

  // 5. Parse chunked response
  const envelopes = parseStreamedChunks(responseText);

  if (envelopes.length === 0) {
    // Try to parse the entire response as a fallback
    log?.('[notebooklm] No wrb.fr envelopes found in response, attempting raw parse');
    const stripped = responseText.replace(/^\)\]\}'\n/, '');
    let rawParsed: unknown;
    try {
      // Try parsing each line
      for (const line of stripped.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          rawParsed = JSON.parse(trimmed);
          if (rawParsed) break;
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }

    if (rawParsed) {
      const answer = extractAnswerText(rawParsed);
      if (answer) {
        return {
          answer,
          conversationId: extractConversationId(rawParsed, conversationUuid),
          citations: extractCitations(rawParsed, sourceIds),
        };
      }
    }

    throw new Error('Failed to parse chat response — no valid data envelopes found.');
  }

  // 6. Extract answer from parsed envelopes
  let bestAnswer = '';
  let bestData: unknown = null;

  for (const envelope of envelopes) {
    // Data is at index [2] as a JSON string, or at index [5]
    let data: unknown = null;

    if (typeof envelope[2] === 'string' && envelope[2].length > 0) {
      try {
        data = JSON.parse(envelope[2]);
      } catch {
        data = envelope[2];
      }
    } else if (envelope[5] !== undefined && envelope[5] !== null) {
      if (typeof envelope[5] === 'string') {
        try {
          data = JSON.parse(envelope[5]);
        } catch {
          data = envelope[5];
        }
      } else {
        data = envelope[5];
      }
    }

    if (!data) continue;

    const answer = typeof data === 'string' ? data : extractAnswerText(data);
    if (answer.length > bestAnswer.length) {
      bestAnswer = answer;
      bestData = data;
    }
  }

  if (!bestAnswer) {
    throw new Error('Chat response did not contain an answer. The AI may not have generated a response.');
  }

  // 7. Return ChatResponse
  const finalConversationId = bestData
    ? extractConversationId(bestData, conversationUuid)
    : conversationUuid;

  const citations = bestData
    ? extractCitations(bestData, sourceIds)
    : [];

  log?.(`[notebooklm] Chat response received (${bestAnswer.length} chars, ${citations.length} citations)`);

  return {
    answer: bestAnswer,
    conversationId: finalConversationId,
    citations,
  };
}
