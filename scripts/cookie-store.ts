import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LogFn, NotebookLMCookieFileV1 } from './types.js';
import { resolveCookiePath } from './paths.js';

export const NOTEBOOKLM_COOKIE_NAMES = [
    'SID',
    'HSID',
    'SSID',
    'APISID',
    'SAPISID',
    '__Secure-1PSID',
    '__Secure-1PSIDTS',
    '__Secure-1PSIDCC',
    '__Secure-1PAPISID',
    '__Secure-3PSID',
    '__Secure-3PSIDTS',
    '__Secure-3PAPISID',
    'NID',
    'AEC',
    'SOCS',
    'SIDCC',
    '__Secure-ENID',
] as const;

export const NOTEBOOKLM_REQUIRED_COOKIES = ['SID', '__Secure-1PSID'] as const;

export function hasRequiredCookies(cookieMap: Record<string, string>): boolean {
    return NOTEBOOKLM_REQUIRED_COOKIES.every((name) => Boolean(cookieMap[name]));
}

function resolveCookieDomain(cookie: { domain?: string; url?: string }): string | null {
    const rawDomain = cookie.domain?.trim();
    if (rawDomain) {
        return rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
    }
    const rawUrl = cookie.url?.trim();
    if (rawUrl) {
        try {
            return new URL(rawUrl).hostname;
        } catch {
            return null;
        }
    }
    return null;
}

function pickCookieValue<T extends { name?: string; value?: string; domain?: string; path?: string; url?: string }>(
    cookies: T[],
    name: string,
): string | undefined {
    const matches = cookies.filter((cookie) => cookie.name === name && typeof cookie.value === 'string');
    if (matches.length === 0) return undefined;

    const preferredDomain = matches.find((cookie) => {
        const domain = resolveCookieDomain(cookie);
        return domain === 'google.com' && (cookie.path ?? '/') === '/';
    });
    const googleDomain = matches.find((cookie) => (resolveCookieDomain(cookie) ?? '').endsWith('google.com'));
    return (preferredDomain ?? googleDomain ?? matches[0])?.value;
}

export function buildCookieMap<
    T extends { name?: string; value?: string; domain?: string; path?: string; url?: string },
>(cookies: T[]): Record<string, string> {
    const cookieMap: Record<string, string> = {};

    // Capture ALL Google-domain cookies, not just a hardcoded list.
    // Google's passive login check requires cookies like OSID, __Secure-OSID,
    // __Host-GAPS, LSID, __Host-1PLSID, ACCOUNT_CHOOSER, etc. that are
    // not in the standard auth cookie set but are essential for session validation.
    const seen = new Set<string>();
    for (const cookie of cookies) {
        if (!cookie.name || typeof cookie.value !== 'string' || !cookie.value) continue;
        const domain = resolveCookieDomain(cookie);
        if (!domain || (!domain.endsWith('google.com') && !domain.includes('notebooklm'))) continue;

        // For duplicates, prefer .google.com root domain with path /
        if (seen.has(cookie.name)) {
            if (domain === 'google.com' && (cookie.path ?? '/') === '/') {
                cookieMap[cookie.name] = cookie.value;
            }
        } else {
            seen.add(cookie.name);
            cookieMap[cookie.name] = cookie.value;
        }
    }

    return cookieMap;
}

export async function readCookieMapFromDisk(options?: {
    cookiePath?: string;
    log?: LogFn;
}): Promise<Record<string, string>> {
    const cookiePath = options?.cookiePath ?? resolveCookiePath();

    try {
        const raw = await readFile(cookiePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<NotebookLMCookieFileV1> | Record<string, unknown>;

        const cookieMap =
            (parsed as Partial<NotebookLMCookieFileV1>).version === 1
                ? (parsed as Partial<NotebookLMCookieFileV1>).cookieMap
                : (parsed as Record<string, unknown>);

        if (!cookieMap || typeof cookieMap !== 'object') return {};
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(cookieMap)) {
            if (typeof value === 'string' && value.trim()) {
                normalized[key] = value;
            }
        }

        if (Object.keys(normalized).length > 0) {
            options?.log?.(`[notebooklm] Loaded cookies from ${cookiePath}`);
        }

        return normalized;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') return {};
        options?.log?.(
            `[notebooklm] Failed to read cookies from ${cookiePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {};
    }
}

export async function writeCookieMapToDisk(
    cookieMap: Record<string, string>,
    options?: { cookiePath?: string; log?: LogFn },
): Promise<void> {
    const cookiePath = options?.cookiePath ?? resolveCookiePath();
    await mkdir(path.dirname(cookiePath), { recursive: true });

    const payload: NotebookLMCookieFileV1 = {
        version: 1,
        updatedAt: new Date().toISOString(),
        cookieMap,
    };

    await writeFile(cookiePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
        await chmod(cookiePath, 0o600);
    } catch {
        // ignore chmod failures (e.g. on Windows)
    }
    options?.log?.(`[notebooklm] Saved cookies to ${cookiePath}`);
}

export function formatCookieHeader(cookieMap: Record<string, string>): string {
    return Object.entries(cookieMap)
        .filter(([, value]) => Boolean(value))
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}
