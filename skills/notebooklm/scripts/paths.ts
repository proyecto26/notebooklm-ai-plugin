import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const APP_DATA_DIR = 'notebooklm-ai';
const COOKIE_FILE = 'cookies.json';
const PROFILE_DIR = 'chrome-profile';
const LIBRARY_FILE = 'library.json';
const OUTPUTS_DIR = 'outputs';

export function resolveUserDataRoot(): string {
    if (process.platform === 'win32') {
        return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support');
    }
    return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
}

export function resolveDataDir(): string {
    const override = process.env.NOTEBOOKLM_DATA_DIR?.trim();
    if (override) return path.resolve(override);
    return path.join(resolveUserDataRoot(), APP_DATA_DIR);
}

export function resolveCookiePath(): string {
    const override = process.env.NOTEBOOKLM_COOKIE_PATH?.trim();
    if (override) return path.resolve(override);
    return path.join(resolveDataDir(), COOKIE_FILE);
}

export function resolveChromeProfileDir(): string {
    const override = process.env.NOTEBOOKLM_CHROME_PROFILE_DIR?.trim();
    if (override) return path.resolve(override);
    return path.join(resolveDataDir(), PROFILE_DIR);
}

export function resolveLibraryPath(): string {
    return path.join(resolveDataDir(), LIBRARY_FILE);
}

export function resolveOutputDir(): string {
    const override = process.env.NOTEBOOKLM_OUTPUT_DIR?.trim();
    if (override) return path.resolve(override);
    return path.join(resolveDataDir(), OUTPUTS_DIR);
}
