import { RPCClient } from './rpc-client.js';
import { RPC } from './rpc-types.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ResearchResult {
  taskId: string;
  status: 'in_progress' | 'completed';
  query: string;
  sources: ResearchSource[];
  summary?: string;
}

export interface ResearchSource {
  url?: string;
  title: string;
  description?: string;
  type: 'web' | 'report';
  content?: string; // markdown for deep research reports
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Extracts the task ID from a research start response.
 * The response is a nested array; the task ID is typically the first
 * string that looks like a Google-style ID.
 */
function extractTaskId(response: unknown): string {
  if (typeof response === 'string' && response.length >= 8) {
    return response;
  }
  if (Array.isArray(response)) {
    // Check top-level first element
    if (typeof response[0] === 'string' && response[0].length >= 8) {
      return response[0];
    }
    // Check nested first element
    if (Array.isArray(response[0]) && typeof response[0][0] === 'string' && response[0][0].length >= 8) {
      return response[0][0];
    }
    // Fallback: generic ID search
    const id = findIdInNested(response);
    if (id) return id;
  }
  throw new Error('Failed to extract task ID from research start response');
}

/**
 * Parses sources from the poll response source data array.
 * Fast research sources: [url, title, description, type, ...]
 * Deep research sources: [null, [title, markdown], null, type, ...]
 */
function parseSources(sourcesData: unknown): ResearchSource[] {
  if (!Array.isArray(sourcesData)) return [];

  const sources: ResearchSource[] = [];

  for (const entry of sourcesData) {
    if (!Array.isArray(entry)) continue;

    // Deep research report: [null, [title, markdown], null, type, ...]
    if (entry[0] === null && Array.isArray(entry[1]) && typeof entry[1][0] === 'string') {
      const title = entry[1][0];
      const content = typeof entry[1][1] === 'string' ? entry[1][1] : undefined;
      sources.push({ title, content, type: 'report' });
      continue;
    }

    // Fast research web source: [url, title, description, type, ...]
    if (typeof entry[0] === 'string') {
      const url = entry[0] || undefined;
      const title = typeof entry[1] === 'string' ? entry[1] : (url ?? 'Untitled');
      const description = typeof entry[2] === 'string' ? entry[2] : undefined;
      sources.push({ url, title, description, type: 'web' });
      continue;
    }
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Research functions
// ---------------------------------------------------------------------------

/**
 * Starts a fast (web) research task in a notebook.
 * Returns immediately with a task ID that can be polled for progress.
 */
export async function startFastResearch(
  rpc: RPCClient,
  notebookId: string,
  query: string,
): Promise<ResearchResult> {
  const params = [
    [query, 1], // 1 = web source type
    null,
    1,
    notebookId,
  ];

  const response = await rpc.execute(RPC.START_FAST_RESEARCH, params, `/notebook/${notebookId}`);
  const taskId = extractTaskId(response);

  return { taskId, status: 'in_progress', query, sources: [] };
}

/**
 * Starts a deep research task in a notebook.
 * Deep research takes longer but produces a comprehensive report.
 * Returns immediately with a task ID that can be polled for progress.
 */
export async function startDeepResearch(
  rpc: RPCClient,
  notebookId: string,
  query: string,
): Promise<ResearchResult> {
  const params = [
    null,
    [1],
    [query, 1], // 1 = web
    5,
    notebookId,
  ];

  const response = await rpc.execute(RPC.START_DEEP_RESEARCH, params, `/notebook/${notebookId}`);
  const taskId = extractTaskId(response);

  return { taskId, status: 'in_progress', query, sources: [] };
}

/**
 * Polls the current research status for a notebook.
 * Returns the latest research result including any discovered sources.
 */
export async function pollResearch(
  rpc: RPCClient,
  notebookId: string,
): Promise<ResearchResult> {
  const params = [null, null, notebookId];
  const response = await rpc.execute(RPC.POLL_RESEARCH, params, `/notebook/${notebookId}`);

  const data = response as unknown[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Empty response from POLL_RESEARCH');
  }

  // response[0] = [taskId, taskInfo]
  const taskEntry = Array.isArray(data[0]) ? data[0] : data;
  const taskId = typeof taskEntry[0] === 'string' ? taskEntry[0] : '';

  const taskInfo = Array.isArray(taskEntry[1]) ? taskEntry[1] : taskEntry;

  // taskInfo[1] = [queryText, ...]
  let query = '';
  if (Array.isArray(taskInfo[1]) && typeof taskInfo[1][0] === 'string') {
    query = taskInfo[1][0];
  }

  // taskInfo[4] = statusCode (1=in_progress, 2=completed, 6=completed_deep)
  let statusCode = 0;
  if (typeof taskInfo[4] === 'number') {
    statusCode = taskInfo[4];
  }

  const status: 'in_progress' | 'completed' =
    statusCode === 2 || statusCode === 6 ? 'completed' : 'in_progress';

  // taskInfo[3] = [sourcesData, summary]
  let sources: ResearchSource[] = [];
  let summary: string | undefined;

  if (Array.isArray(taskInfo[3])) {
    const sourcesRaw = taskInfo[3][0];
    if (Array.isArray(sourcesRaw)) {
      sources = parseSources(sourcesRaw);
    }
    if (typeof taskInfo[3][1] === 'string') {
      summary = taskInfo[3][1];
    }
  }

  return { taskId, status, query, sources, summary };
}

/**
 * Imports research results (sources) into a notebook.
 * This adds the discovered sources from research as notebook sources.
 */
export async function importResearch(
  rpc: RPCClient,
  notebookId: string,
  taskId: string,
  sources: ResearchSource[],
): Promise<unknown> {
  const sourceArray = sources.map((s) => {
    if (s.type === 'web') {
      return [null, null, [s.url, s.title], null, null, null, null, null, null, null, 2];
    } else {
      return [null, [s.title, s.content], null, 3, null, null, null, null, null, null, 3];
    }
  });

  const params = [null, [1], taskId, notebookId, sourceArray];
  return rpc.execute(RPC.IMPORT_RESEARCH, params, `/notebook/${notebookId}`);
}

/**
 * Waits for a research task to complete by polling at regular intervals.
 * Returns the final research result with all discovered sources.
 *
 * @param rpc       The RPC client
 * @param notebookId The notebook ID
 * @param taskId     The task ID returned by startFastResearch/startDeepResearch
 * @param options    Optional polling configuration
 * @returns The completed research result
 * @throws If the task does not complete within the timeout period
 */
export async function waitForResearch(
  rpc: RPCClient,
  notebookId: string,
  taskId: string,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<ResearchResult> {
  const intervalMs = options?.intervalMs ?? 5000;
  const timeoutMs = options?.timeoutMs ?? 600_000; // 10 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await pollResearch(rpc, notebookId);

    // Verify this is the task we're waiting for
    if (result.taskId === taskId && result.status === 'completed') {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Research task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
      'The task may still be running — try polling again later.',
  );
}
