import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { formatCookieHeader } from './cookie-store.js';

const BATCHEXECUTE_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';
const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

/**
 * Parses the batchexecute chunked response format.
 *
 * The response body (after stripping the anti-XSSI prefix) consists of
 * alternating lines: a byte-count line followed by a JSON payload line.
 * We look for arrays whose first element is "wrb.fr" and second element
 * matches the requested rpcId. The actual data is at index [2] (a JSON
 * string to re-parse) with a fallback to index [5].
 */
function parseBatchResponse(text: string, rpcId: string): unknown {
  // Strip anti-XSSI prefix
  const stripped = text.replace(/^\)\]\}'\n/, '');

  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Try to parse each line as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!Array.isArray(parsed)) continue;

    // The top-level array may contain nested arrays
    // Look for ["wrb.fr", rpcId, dataJsonString, ...]
    const envelopes: unknown[][] = [];
    if (typeof parsed[0] === 'string' && parsed[0] === 'wrb.fr') {
      envelopes.push(parsed);
    } else {
      for (const item of parsed) {
        if (Array.isArray(item) && item[0] === 'wrb.fr') {
          envelopes.push(item);
        }
      }
    }

    for (const envelope of envelopes) {
      if (envelope[1] !== rpcId) continue;

      // Data is at index [2] as a JSON string
      if (typeof envelope[2] === 'string' && envelope[2].length > 0) {
        try {
          return JSON.parse(envelope[2]);
        } catch {
          return envelope[2];
        }
      }

      // Fallback to index [5]
      if (envelope[5] !== undefined && envelope[5] !== null) {
        if (typeof envelope[5] === 'string') {
          try {
            return JSON.parse(envelope[5]);
          } catch {
            return envelope[5];
          }
        }
        return envelope[5];
      }
    }
  }

  throw new Error(`No response found for RPC ${rpcId} in batchexecute response`);
}

export class RPCClient {
  private cookieMap: Record<string, string>;
  private csrfToken = ''; // SNlM0e
  private sessionId = ''; // FdrFJe
  private reqCounter = 100000;

  constructor(cookieMap: Record<string, string>) {
    this.cookieMap = cookieMap;
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

    // Handle redirect — if we get 302, cookies aren't working
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      throw new Error(
        `NotebookLM redirected (${res.status}) to ${location.substring(0, 80)}. Cookies may be expired — try running "login --force".`,
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
        'origin': 'https://notebooklm.google.com',
        'referer': 'https://notebooklm.google.com/',
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
    return parseBatchResponse(responseText, rpcId);
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
        headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://notebooklm.google.com/' },
        redirect: 'follow',
      });
      const ct = simpleRes.headers.get('content-type') ?? '';
      if (simpleRes.ok && !ct.includes('text/html') && simpleRes.body) {
        const nodeStream = Readable.fromWeb(simpleRes.body as Parameters<typeof Readable.fromWeb>[0]);
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
                'Referer': 'https://notebooklm.google.com/',
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
