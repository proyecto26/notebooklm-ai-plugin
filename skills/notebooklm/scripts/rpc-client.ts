import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { formatCookieHeader } from './cookie-store.js';
import { BATCHEXECUTE_URL, NOTEBOOKLM_ORIGIN, NOTEBOOKLM_URL, USER_AGENT, isNotebookLMAppUrl } from './constants.js';

/**
 * Extracts Set-Cookie values from a response and merges them into the cookie map.
 * This is critical for Google's auth flow — each redirect hop sets new cookies
 * that must be sent on subsequent requests.
 */
function applySetCookies(res: Response, cookieMap: Record<string, string>): void {
  const headers = res.headers as unknown as { getSetCookie?: () => string[] };
  let setCookies: string[] = [];
  if (typeof headers.getSetCookie === 'function') {
    try { setCookies = headers.getSetCookie(); } catch { /* ignore */ }
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) setCookies = [raw];
  }
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim();
    if (!first) continue;
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) cookieMap[name] = value;
  }
}

/**
 * Fetch with cookie jar — follows redirects manually while applying
 * Set-Cookie headers from each hop back to the cookie map.
 * This matches the pattern used by sherlock-ai-plugin's Gemini client.
 */
async function fetchWithCookieJar(
  url: string,
  init: Omit<RequestInit, 'redirect' | 'headers'> & { headers?: Record<string, string> },
  cookieMap: Record<string, string>,
  signal?: AbortSignal,
  maxRedirects = 20,
): Promise<Response> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const cookieHeader = formatCookieHeader(cookieMap);
    const headers: Record<string, string> = {
      ...(init.headers ?? {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      'User-Agent': USER_AGENT,
    };

    const fetchOpts: Record<string, unknown> = {
      method: (init as any).method ?? 'GET',
      redirect: 'manual',
      headers,
    };
    if ((init as any).body !== undefined) fetchOpts.body = (init as any).body;
    if (signal) fetchOpts.signal = signal;
    const res = await fetch(current, fetchOpts as RequestInit);
    applySetCookies(res, cookieMap);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      current = new URL(location, current).toString();
      continue;
    }

    return res;
  }

  throw new Error(`Too many redirects while fetching ${url} (>${maxRedirects}).`);
}

/** Thrown when the batchexecute envelope reports an error for the requested RPC. */
export class RPCError extends Error {
  constructor(
    message: string,
    public readonly rpcId: string,
    public readonly code?: number,
    public readonly kind: 'rate_limit' | 'auth' | 'not_found' | 'server' | 'client' | 'drift' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'RPCError';
  }
}

/** Strips Google's anti-XSSI prefix `)]}'` (+ newline) when present. */
export function stripAntiXssi(text: string): string {
  return text.replace(/^\)\]\}'\r?\n?/, '');
}

/**
 * Splits an `rt=c` chunked body into its JSON payloads.
 * The body alternates `<byte-count>\n<json>\n`; byte counts are advisory (Google
 * appears to count UTF-16 units) so we parse line-by-line instead of by length.
 */
export function parseChunkedPayloads(text: string): unknown[] {
  const payloads: unknown[] = [];
  for (const rawLine of stripAntiXssi(text).split('\n')) {
    const line = rawLine.trim();
    if (!line || /^\d+$/.test(line)) continue;
    try {
      payloads.push(JSON.parse(line));
    } catch {
      /* not a JSON line */
    }
  }
  return payloads;
}

/** Collects `["wrb.fr", ...]` / `["er", ...]` envelopes from parsed payloads. */
export function collectEnvelopes(payloads: unknown[]): unknown[][] {
  const envelopes: unknown[][] = [];
  for (const parsed of payloads) {
    if (!Array.isArray(parsed)) continue;
    if (parsed[0] === 'wrb.fr' || parsed[0] === 'er') {
      envelopes.push(parsed);
      continue;
    }
    for (const item of parsed) {
      if (Array.isArray(item) && (item[0] === 'wrb.fr' || item[0] === 'er')) envelopes.push(item);
    }
  }
  return envelopes;
}

function describeStatus(rpcId: string, status: unknown): RPCError | null {
  if (!Array.isArray(status)) return null;
  const code = typeof status[0] === 'number' ? status[0] : undefined;
  const json = JSON.stringify(status);
  if (json.includes('UserDisplayableError')) {
    return new RPCError(
      `RPC ${rpcId} was rejected by NotebookLM (rate limit or quota reached, or the feature is unavailable for this account).`,
      rpcId, code, 'rate_limit',
    );
  }
  if (code === undefined || code === 0) return null;
  const map: Record<number, [string, RPCError['kind']]> = {
    3: ['INVALID_ARGUMENT — the request payload was rejected (the RPC shape may have changed)', 'client'],
    5: ['NOT_FOUND — the notebook/artifact/source does not exist or is not accessible', 'not_found'],
    7: ['PERMISSION_DENIED — cookies may belong to a different account', 'auth'],
    8: ['RESOURCE_EXHAUSTED — quota or rate limit', 'rate_limit'],
    9: ['FAILED_PRECONDITION — the request payload was rejected (the RPC shape may have changed)', 'client'],
    13: ['INTERNAL server error', 'server'],
    14: ['UNAVAILABLE — server temporarily unavailable', 'server'],
    16: ['UNAUTHENTICATED — cookies are expired, run "login --force"', 'auth'],
  };
  const [msg, kind] = map[code] ?? [`status code ${code}`, 'unknown'];
  return new RPCError(`RPC ${rpcId} failed: ${msg}`, rpcId, code, kind);
}

/**
 * Decodes a batchexecute response for one RPC id.
 *
 * Envelope layout: `["wrb.fr", rpcId, "<inner json>", null, null, [status...], "generic"]`.
 * Google may send several envelopes for the same id (placeholders with a null
 * payload followed by the real one) — the last non-null payload wins. `["er", ...]`
 * envelopes and non-OK status blocks (index 5) become RPCError. A missing id when
 * other ids are present means the method id has rotated ("drift").
 *
 * Returns `null` for RPCs that legitimately return nothing (updates, deletes).
 */
export function decodeBatchResponse(text: string, rpcId: string): unknown {
  const envelopes = collectEnvelopes(parseChunkedPayloads(text));
  let result: unknown = null;
  let sawId = false;
  let statusError: RPCError | null = null;
  const seenIds = new Set<string>();

  for (const env of envelopes) {
    if (typeof env[1] === 'string') seenIds.add(env[1]);
    if (env[1] !== rpcId) continue;
    sawId = true;

    if (env[0] === 'er') {
      const code = typeof env[2] === 'number' ? env[2] : undefined;
      throw describeStatus(rpcId, [code]) ?? new RPCError(`RPC ${rpcId} returned an error frame`, rpcId, code);
    }

    const payload = env[2];
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        result = JSON.parse(payload);
      } catch {
        result = payload;
      }
    } else if (payload === null || payload === undefined) {
      statusError = describeStatus(rpcId, env[5]) ?? statusError;
    }
  }

  if (!sawId) {
    if (envelopes.length === 0) {
      throw new RPCError(`RPC ${rpcId}: response contained no batchexecute envelopes (empty body or login page?)`, rpcId, undefined, 'unknown');
    }
    throw new RPCError(
      `RPC ${rpcId} not present in response (got: ${[...seenIds].join(', ') || 'none'}). The method ID may have changed.`,
      rpcId, undefined, 'drift',
    );
  }
  if (result === null && statusError) throw statusError;
  return result;
}

export class RPCClient {
  private cookieMap: Record<string, string>;
  private csrfToken = ''; // SNlM0e
  private sessionId = ''; // FdrFJe
  private reqCounter = 100000;

  constructor(cookieMap: Record<string, string>) {
    this.cookieMap = cookieMap;
  }

  /** Returns the CSRF token extracted during init(). */
  getCsrfToken(): string {
    return this.csrfToken;
  }

  /** Returns the session ID extracted during init(). */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Returns the cookie map used by this client. */
  getCookieMap(): Record<string, string> {
    return this.cookieMap;
  }

  /**
   * Initializes the client by fetching the NotebookLM page and extracting
   * the CSRF token (SNlM0e) and session ID (FdrFJe) from the HTML.
   */
  async init(): Promise<void> {
    // Direct fetch with cookies — simpler than fetchWithCookieJar for the init step.
    // NotebookLM returns 200 directly when cookies are valid (no redirect needed).
    const cookieHeader = formatCookieHeader(this.cookieMap);
    const res = await fetch(NOTEBOOKLM_URL, {
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
    });

    // Handle redirect — a redirect to /login or accounts.google.com means the
    // cookies aren't authenticating. A redirect to a *different* app host means
    // NOTEBOOKLM_ORIGIN is stale (Google renamed the service) — surface that distinctly.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      let resolved = location;
      try { resolved = new URL(location, NOTEBOOKLM_URL).toString(); } catch { /* keep raw */ }
      if (isNotebookLMAppUrl(resolved) && !resolved.includes('/login')) {
        throw new Error(
          `NotebookLM redirected (${res.status}) to ${resolved.substring(0, 80)}. ` +
            'The app origin may have changed — set NOTEBOOKLM_BASE_URL or update scripts/constants.ts.',
        );
      }
      throw new Error(
        `NotebookLM redirected (${res.status}) to ${resolved.substring(0, 80)}. Cookies may be expired — try running "login --force".`,
      );
    }

    if (!res.ok) {
      throw new Error(`Failed to load NotebookLM page: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();

    // Check if we got a login page instead of the app
    // Only check if we DON'T have the app signature — the app HTML may contain
    // references to ServiceLogin in embedded scripts/URLs
    if (!html.includes('LabsTailwindUi') && (html.includes('accounts.google.com/v3/signin') || html.includes('ServiceLogin'))) {
      throw new Error(
        'NotebookLM redirected to Google login. Cookies may be expired — try running "login --force".',
      );
    }

    // The app shell embeds its own bundle name; a page without it is not NotebookLM.
    if (!html.includes('LabsTailwindUi') && !html.includes('WIZ_global_data')) {
      throw new Error('Unexpected page content from NotebookLM (not the app shell). Try running "login --force".');
    }

    // Extract SNlM0e (CSRF token)
    const snlm0eMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/) || html.match(/SNlM0e.*?"([^"]{20,})"/);
    if (!snlm0eMatch) {
      throw new Error(
        'Failed to extract CSRF token (SNlM0e) from NotebookLM page. ' +
          'Cookies may be expired — try running "login --force".',
      );
    }
    this.csrfToken = snlm0eMatch[1];

    // Extract FdrFJe (session ID)
    const fdrfjeMatch = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
    if (fdrfjeMatch) {
      this.sessionId = fdrfjeMatch[1];
    } else {
      this.sessionId = '';
    }
  }

  /**
   * Executes a single RPC call via the batchexecute protocol.
   *
   * @param rpcId  The RPC method identifier (e.g. "R7cb6c" for CREATE_ARTIFACT)
   * @param params The parameter array for the RPC call
   * @param sourcePath Optional source-path query param (defaults to "/")
   * @returns The parsed response data
   */
  async execute(rpcId: string, params: unknown[], sourcePath?: string): Promise<unknown> {
    const fReq = JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]]);

    const body = new URLSearchParams({
      'f.req': fReq,
      at: this.csrfToken,
    });

    const url = new URL(BATCHEXECUTE_URL);
    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('source-path', sourcePath || '/');
    url.searchParams.set('f.sid', this.sessionId);
    url.searchParams.set('hl', 'en');
    url.searchParams.set('_reqid', String(this.reqCounter++));
    url.searchParams.set('rt', 'c');

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Cookie': formatCookieHeader(this.cookieMap),
        'User-Agent': USER_AGENT,
        'origin': NOTEBOOKLM_ORIGIN,
        'referer': NOTEBOOKLM_URL,
        'x-same-domain': '1',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `RPC ${rpcId} failed: ${response.status} ${response.statusText}` +
          (text ? `\n${text.slice(0, 500)}` : ''),
      );
    }

    const responseText = await response.text();
    return decodeBatchResponse(responseText, rpcId);
  }

  /**
   * Downloads a media file from a Google URL using cookie authentication.
   * Follows redirects and streams the response body to disk.
   *
   * @param url The media URL to download
   * @param outputPath The local file path to write to
   */
  async fetchMediaWithCookies(url: string, outputPath: string): Promise<void> {
    await mkdir(path.dirname(outputPath), { recursive: true });

    // Strategy 1: Simple fetch with redirect: 'follow' (works for static images like infographics)
    try {
      const simpleRes = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Referer': NOTEBOOKLM_URL },
        redirect: 'follow',
      });
      const ct = simpleRes.headers.get('content-type') ?? '';
      if (simpleRes.ok && !ct.includes('text/html') && simpleRes.body) {
        const nodeStream = Readable.fromWeb(simpleRes.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
        const fileStream = createWriteStream(outputPath);
        await pipeline(nodeStream, fileStream);
        return;
      }
    } catch { /* fall through to strategy 2 */ }

    const googleCookieHeader = formatCookieHeader(this.cookieMap);

    // Use Node's native https module for media downloads.
    // Bun/Node fetch has issues with Google's media redirect chain
    // (lh3.googleusercontent.com -> lh3.google.com/rd-notebooklm -> googlevideo.com).
    // Native https.request follows redirects correctly when we re-attach cookies.
    const downloadWithNode = (downloadUrl: string, maxRedirects = 10): Promise<void> => {
      return new Promise((resolve, reject) => {
        const doRequest = (reqUrl: string, redirectsLeft: number) => {
          const parsed = new URL(reqUrl);
          const mod = parsed.protocol === 'https:' ? https : http;

          const req = mod.request(
            reqUrl,
            {
              method: 'GET',
              headers: {
                'Cookie': googleCookieHeader,
                'User-Agent': USER_AGENT,
                'Referer': NOTEBOOKLM_URL,
              },
            },
            (res) => {
              // Follow redirects manually with cookies
              if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (redirectsLeft <= 0) {
                  reject(new Error(
                    `Media redirect loop detected. The artifact was created successfully but ` +
                    `cannot be downloaded automatically. Open this URL in your browser to download: ${url}`
                  ));
                  return;
                }
                const next = res.headers.location.startsWith('http')
                  ? res.headers.location
                  : new URL(res.headers.location, reqUrl).toString();
                res.resume(); // drain response
                doRequest(next, redirectsLeft - 1);
                return;
              }

              if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                reject(new Error(`Media download failed: ${res.statusCode} — ${reqUrl}`));
                return;
              }

              // Check for HTML response (consent page)
              const ct = res.headers['content-type'] ?? '';
              if (ct.includes('text/html')) {
                res.resume();
                reject(new Error(
                  `Media download returned HTML instead of binary content. ` +
                  `The artifact was created but requires browser download. URL: ${url}`
                ));
                return;
              }

              // Stream to file
              const fileStream = createWriteStream(outputPath);
              res.pipe(fileStream);
              fileStream.on('finish', () => resolve());
              fileStream.on('error', (err) => reject(err));
              res.on('error', (err) => reject(err));
            },
          );
          req.on('error', (err) => reject(err));
          req.end();
        };

        doRequest(downloadUrl, maxRedirects);
      });
    };

    await downloadWithNode(url);
  }
}
