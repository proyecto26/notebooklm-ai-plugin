#!/usr/bin/env -S npx -y bun

import process from 'node:process';

import { getNotebookLMCookiesViaChrome } from './auth.js';
import { writeCookieMapToDisk } from './cookie-store.js';
import { resolveChromeProfileDir, resolveCookiePath } from './paths.js';

async function main(): Promise<void> {
    const log = (msg: string) => console.log(msg);
    const cookieMap = await getNotebookLMCookiesViaChrome({
        userDataDir: resolveChromeProfileDir(),
        log,
    });
    await writeCookieMapToDisk(cookieMap, { cookiePath: resolveCookiePath(), log });
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
