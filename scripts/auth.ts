import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import process from 'node:process';

import { buildCookieMap, formatCookieHeader, hasRequiredCookies } from './cookie-store.js';
import { resolveChromeProfileDir } from './paths.js';
import type { LogFn } from './types.js';

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Unable to allocate a free TCP port for Chrome debugging.')));
                return;
            }
            const port = address.port;
            server.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
    });
}

function findChromeExecutable(): string | undefined {
    const override = process.env.NOTEBOOKLM_CHROME_PATH?.trim();
    if (override && fs.existsSync(override)) return override;

    const candidates: string[] = [];
    switch (process.platform) {
        case 'darwin':
            candidates.push(
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
                '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
                '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            );
            break;
        case 'win32':
            candidates.push(
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            );
            break;
        default:
            candidates.push(
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/snap/bin/chromium',
                '/usr/bin/microsoft-edge',
                '/usr/bin/microsoft-edge-stable',
            );
            break;
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`Request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return (await res.json()) as T;
}

async function waitForChromeDebugPort(
    port: number,
    timeoutMs: number,
): Promise<{ webSocketDebuggerUrl: string }> {
    const start = Date.now();
    let lastError: unknown = null;

    while (Date.now() - start < timeoutMs) {
        try {
            const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
                `http://127.0.0.1:${port}/json/version`,
            );
            if (version.webSocketDebuggerUrl) {
                return { webSocketDebuggerUrl: version.webSocketDebuggerUrl };
            }
            lastError = new Error('Missing webSocketDebuggerUrl');
        } catch (error) {
            lastError = error;
        }

        await sleep(200);
    }

    throw new Error(
        `Chrome debugging endpoint did not become ready within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

class CdpConnection {
    private ws: WebSocket;
    private nextId = 0;
    private pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> | null }
    >();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        this.ws.addEventListener('message', (event) => {
            try {
                const data = (() => {
                    if (typeof event.data === 'string') return event.data;
                    if (event.data instanceof ArrayBuffer) {
                        return new TextDecoder().decode(new Uint8Array(event.data));
                    }
                    if (ArrayBuffer.isView(event.data)) {
                        return new TextDecoder().decode(event.data);
                    }
                    return String(event.data);
                })();
                const msg = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } };
                if (!msg.id) return;
                const pending = this.pending.get(msg.id);
                if (!pending) return;
                this.pending.delete(msg.id);
                if (pending.timer) clearTimeout(pending.timer);
                if (msg.error?.message) pending.reject(new Error(msg.error.message));
                else pending.resolve(msg.result);
            } catch {
                // ignore malformed events
            }
        });

        this.ws.addEventListener('close', () => {
            for (const [id, pending] of this.pending.entries()) {
                this.pending.delete(id);
                if (pending.timer) clearTimeout(pending.timer);
                pending.reject(new Error('Chrome DevTools connection closed.'));
            }
        });
    }

    static async connect(url: string, timeoutMs: number): Promise<CdpConnection> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools.')), timeoutMs);
            ws.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('Failed to connect to Chrome DevTools.'));
            });
        });
        return new CdpConnection(ws);
    }

    async send<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
        options?: { sessionId?: string; timeoutMs?: number },
    ): Promise<T> {
        const id = (this.nextId += 1);
        const message: Record<string, unknown> = { id, method };
        if (params) message.params = params;
        if (options?.sessionId) message.sessionId = options.sessionId;

        const timeoutMs = options?.timeoutMs ?? 15_000;

        const result = await new Promise<unknown>((resolve, reject) => {
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.pending.delete(id);
                          reject(new Error(`CDP command timeout (${method}) after ${timeoutMs}ms.`));
                      }, timeoutMs)
                    : null;
            this.pending.set(id, {
                resolve,
                reject: (reason) => reject(reason),
                timer,
            });
            this.ws.send(JSON.stringify(message));
        });

        return result as T;
    }

    close(): void {
        try {
            this.ws.close();
        } catch {
            // ignore
        }
    }
}

/**
 * Validates cookies by fetching NotebookLM and checking for the "SNlM0e" session token
 * in the HTML response. This confirms the cookies grant authenticated access.
 */
async function validateNotebookLMSession(
    cookieMap: Record<string, string>,
    signal?: AbortSignal,
): Promise<void> {
    const cookieHeader = formatCookieHeader(cookieMap);
    // Use redirect: 'manual' to detect login redirects.
    // If NotebookLM returns 302 to accounts.google.com, the cookies are not valid.
    const res = await fetch(NOTEBOOKLM_URL, {
        headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        redirect: 'manual',
        signal,
    });

    // A 302 redirect to accounts.google.com means cookies are not authenticating
    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') ?? '';
        if (location.includes('accounts.google.com')) {
            throw new Error('NotebookLM redirected to login — cookies are not valid for authenticated access.');
        }
    }

    if (!res.ok && res.status < 300) {
        throw new Error(`NotebookLM returned HTTP ${res.status} ${res.statusText}`);
    }

    // Must be a 200 with the actual app page
    if (res.status !== 200) {
        throw new Error(`NotebookLM returned unexpected status ${res.status}. Expected 200 for authenticated access.`);
    }

    const html = await res.text();
    // Verify we got the NotebookLM app, not a login page
    if (html.includes('accounts.google.com/ServiceLogin') || html.includes('accounts.google.com/v3/signin')) {
        throw new Error('Got Google login page instead of NotebookLM app — cookies are not valid.');
    }
    if (!html.includes('LabsTailwindUi') && !html.includes('notebooklm')) {
        throw new Error('Page does not appear to be NotebookLM — cookies may be invalid.');
    }
}

export async function getNotebookLMCookiesViaChrome(options?: {
    timeoutMs?: number;
    debugConnectTimeoutMs?: number;
    tokenCheckTimeoutMs?: number;
    pollIntervalMs?: number;
    log?: LogFn;
    userDataDir?: string;
    chromePath?: string;
}): Promise<Record<string, string>> {
    const log = options?.log;
    const timeoutMs = options?.timeoutMs ?? 5 * 60_000;
    const debugConnectTimeoutMs = options?.debugConnectTimeoutMs ?? 30_000;
    const tokenCheckTimeoutMs = options?.tokenCheckTimeoutMs ?? 30_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
    const userDataDir = options?.userDataDir ?? resolveChromeProfileDir();

    const chromePath = options?.chromePath ?? findChromeExecutable();
    if (!chromePath) {
        throw new Error(
            'Unable to locate a Chrome/Chromium executable. Install Google Chrome or set NOTEBOOKLM_CHROME_PATH.',
        );
    }

    await mkdir(userDataDir, { recursive: true });

    const port = await getFreePort();
    log?.(`[notebooklm] Launching Chrome for cookie sync (profile: ${userDataDir})`);

    const chrome = spawn(
        chromePath,
        [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${userDataDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
            NOTEBOOKLM_URL,
        ],
        { stdio: 'ignore' },
    );

    let cdp: CdpConnection | null = null;
    try {
        const { webSocketDebuggerUrl } = await waitForChromeDebugPort(port, debugConnectTimeoutMs);
        cdp = await CdpConnection.connect(webSocketDebuggerUrl, debugConnectTimeoutMs);

        const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: NOTEBOOKLM_URL });
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId,
            flatten: true,
        });

        await cdp.send('Page.enable', {}, { sessionId });
        await cdp.send('Network.enable', {}, { sessionId });

        log?.('[notebooklm] Please log in to NotebookLM in the opened browser window.');
        log?.('[notebooklm] Waiting for cookies to become available...');

        const start = Date.now();
        let lastTokenError: string | null = null;
        while (Date.now() - start < timeoutMs) {
            // Use Network.getAllCookies to get all browser cookies including those
            // that Network.getCookies might miss due to URL scoping.
            const response = await cdp.send<{ cookies?: unknown[] }>(
                'Network.getAllCookies',
                {},
                { sessionId, timeoutMs: 15_000 },
            );

            const rawCookies = Array.isArray(response.cookies) ? response.cookies : [];
            const cookieMap = buildCookieMap(
                rawCookies.filter(
                    (cookie): cookie is { name?: string; value?: string; domain?: string; path?: string; url?: string } =>
                        Boolean(cookie && typeof cookie === 'object'),
                ),
            );

            if (hasRequiredCookies(cookieMap)) {
                // Check that Chrome actually loaded NotebookLM (not the login page)
                // by querying the current page URL via CDP
                try {
                    const evalResult = await cdp.send<{ result?: { value?: string } }>(
                        'Runtime.evaluate',
                        { expression: 'window.location.href' },
                        { sessionId, timeoutMs: 5_000 },
                    );
                    const currentUrl = evalResult?.result?.value ?? '';
                    if (currentUrl.includes('notebooklm.google.com') && !currentUrl.includes('accounts.google.com')) {
                        log?.('[notebooklm] NotebookLM cookies validated successfully.');
                        return cookieMap;
                    }
                    lastTokenError = `Page URL is ${currentUrl} — not authenticated yet`;
                } catch (error) {
                    // If we can't check the URL, still try to return cookies if we have them
                    lastTokenError = error instanceof Error ? error.message : String(error);
                }
            }

            await sleep(pollIntervalMs);
        }

        throw new Error(
            `Timed out waiting for NotebookLM cookies after ${timeoutMs}ms${lastTokenError ? ` (last error: ${lastTokenError})` : ''}.`,
        );
    } finally {
        if (cdp) {
            try {
                await cdp.send('Browser.close', {}, { timeoutMs: 5_000 });
            } catch {
                // ignore
            }
            cdp.close();
        }

        const killTimer = setTimeout(() => {
            if (!chrome.killed) {
                try {
                    chrome.kill('SIGKILL');
                } catch {
                    // ignore
                }
            }
        }, 2_000);
        killTimer.unref?.();
        try {
            chrome.kill('SIGTERM');
        } catch {
            // ignore
        }
    }
}
