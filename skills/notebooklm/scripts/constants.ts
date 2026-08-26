import process from 'node:process';

/**
 * NotebookLM moved from notebooklm.google.com to notebook.google.com in mid-2026.
 * The old host now answers with a 301 to the new one, and the per-service
 * session cookies (OSID / __Secure-OSID) are scoped to the new host — so every
 * request, the CDP login flow, and the "am I logged in?" checks must all target
 * the new origin. Keep the origin in one place so the next rename is a one-line fix.
 *
 * Override with NOTEBOOKLM_BASE_URL (no trailing slash needed).
 */
function resolveOrigin(): string {
    const override = process.env.NOTEBOOKLM_BASE_URL?.trim();
    if (override) return override.replace(/\/+$/, '');
    return 'https://notebook.google.com';
}

export const NOTEBOOKLM_ORIGIN = resolveOrigin();
export const NOTEBOOKLM_HOST = new URL(NOTEBOOKLM_ORIGIN).hostname;
export const NOTEBOOKLM_URL = `${NOTEBOOKLM_ORIGIN}/`;

/** Hosts that identify a NotebookLM page/notebook URL (current + legacy). */
export const NOTEBOOKLM_KNOWN_HOSTS = [NOTEBOOKLM_HOST, 'notebook.google.com', 'notebooklm.google.com'];

/** Internal app id used in the batchexecute path. */
export const APP_ID = 'LabsTailwindUi';
export const BATCHEXECUTE_URL = `${NOTEBOOKLM_ORIGIN}/_/${APP_ID}/data/batchexecute`;
export const CHAT_STREAM_URL =
    `${NOTEBOOKLM_ORIGIN}/_/${APP_ID}/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed`;
export const UPLOAD_URL = `${NOTEBOOKLM_ORIGIN}/upload/_/`;

export const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Builds the canonical URL for a notebook id. */
export function notebookUrl(notebookId: string): string {
    return `${NOTEBOOKLM_ORIGIN}/notebook/${notebookId}`;
}

/** True when the URL points at a NotebookLM app page (current or legacy host). */
export function isNotebookLMAppUrl(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        return NOTEBOOKLM_KNOWN_HOSTS.includes(hostname);
    } catch {
        return false;
    }
}
