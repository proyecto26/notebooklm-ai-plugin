#!/usr/bin/env -S npx -y bun
import process from 'node:process';
import path from 'node:path';

import { readFile } from 'node:fs/promises';

import type { ArtifactConfig, ArtifactType } from './types.js';
import { readCookieMapFromDisk, hasRequiredCookies, writeCookieMapToDisk } from './cookie-store.js';
import { resolveOutputDir } from './paths.js';
import { RPCClient } from './rpc-client.js';
import { RPC } from './rpc-types.js';
import { ArtifactGenerator } from './artifact-generator.js';
import {
  addNotebook,
  removeNotebook,
  listNotebooks,
  searchNotebooks,
  setActiveNotebook,
  getActiveNotebook,
  recordUsage,
  extractNotebookId,
} from './notebook-manager.js';
import { chat } from './chat.js';
import {
  listSources,
  addSourceUrl,
  addSourceYouTube,
  addSourceText,
  addSourceFile,
  deleteSource,
} from './source-manager.js';
import {
  startFastResearch,
  startDeepResearch,
  pollResearch,
  importResearch,
} from './research-manager.js';
import {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
} from './notes-manager.js';

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] = bun/node, argv[1] = script path
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';
  let subcommand: string | undefined;

  // Short flag mappings
  const shortFlags: Record<string, string> = { h: 'help', p: 'prompt', o: 'output' };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else if (arg.startsWith('-') && !arg.startsWith('--') && arg.length === 2) {
      const short = arg.slice(1);
      const key = shortFlags[short] ?? short;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else if (!command) {
      command = arg;
      i += 1;
    } else if (!subcommand && !arg.startsWith('-')) {
      subcommand = arg;
      i += 1;
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, subcommand, positional, flags };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function jsonOutput(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function textOutput(message: string): void {
  process.stdout.write(message + '\n');
}

function errorOutput(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function handleLogin(parsed: ParsedArgs): Promise<void> {
  const force = parsed.flags.force === true;
  const cookieString = parsed.flags.cookies as string | undefined;

  // If user provides a cookie string directly, parse and save it
  if (cookieString) {
    const cookieMap: Record<string, string> = {};
    for (const pair of cookieString.split(';')) {
      const trimmed = pair.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        cookieMap[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
    if (hasRequiredCookies(cookieMap)) {
      await writeCookieMapToDisk(cookieMap, {
        log: (msg: string) => textOutput(msg),
      });
      textOutput(`Cookies saved (${Object.keys(cookieMap).length} cookies parsed from string).`);
    } else {
      errorOutput('Cookie string is missing required cookies (SID, __Secure-1PSID). Check your cookie export.');
      process.exit(1);
    }
    return;
  }

  // Skip if already authenticated (unless --force)
  if (!force) {
    const existing = await readCookieMapFromDisk();
    if (hasRequiredCookies(existing)) {
      textOutput('Already authenticated. Use --force to re-authenticate.');
      return;
    }
  }

  // Dynamic import so the auth module is only loaded when needed
  let getNotebookLMCookiesViaChrome: (options?: { log?: (msg: string) => void }) => Promise<Record<string, string>>;
  try {
    const authModule = await import('./auth.js');
    getNotebookLMCookiesViaChrome = authModule.getNotebookLMCookiesViaChrome;
  } catch {
    errorOutput(
      'Auth module not available. Please ensure scripts/auth.ts exists.\n' +
        'You can also manually place your cookies in the cookie file.\n' +
        'See the documentation for manual cookie setup instructions.',
    );
    process.exit(1);
  }

  textOutput('Opening Chrome for Google authentication...');
  textOutput('Please sign in to your Google account in the browser window.');
  textOutput('The window will close automatically once authentication is complete.\n');

  try {
    const cookieMap = await getNotebookLMCookiesViaChrome({
      log: (msg: string) => textOutput(msg),
    });

    if (hasRequiredCookies(cookieMap)) {
      await writeCookieMapToDisk(cookieMap, {
        log: (msg: string) => textOutput(msg),
      });
      textOutput('Authentication successful! Cookies saved.');
    } else {
      errorOutput('Authentication incomplete — required cookies were not captured.');
      process.exit(1);
    }
  } catch (err) {
    errorOutput(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function handleNotebooks(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand;
  const isJson = parsed.flags.json === true;

  if (!sub || sub === 'list') {
    const notebooks = await listNotebooks();
    const active = await getActiveNotebook();

    if (isJson) {
      jsonOutput({ notebooks, activeId: active?.id ?? null });
      return;
    }

    if (notebooks.length === 0) {
      textOutput('No notebooks in library. Add one with: notebooks add <url>');
      return;
    }

    textOutput('Notebooks:\n');
    for (const nb of notebooks) {
      const marker = nb.id === active?.id ? ' (active)' : '';
      textOutput(`  ${nb.id}${marker}`);
      textOutput(`    Name: ${nb.name}`);
      textOutput(`    URL:  ${nb.url}`);
      if (nb.description) textOutput(`    Desc: ${nb.description}`);
      if (nb.topics?.length) textOutput(`    Tags: ${nb.topics.join(', ')}`);
      textOutput(`    Used: ${nb.useCount} times`);
      textOutput('');
    }
    return;
  }

  if (sub === 'add') {
    const urlOrId = parsed.positional[0] ?? (parsed.flags.url as string);
    if (!urlOrId) {
      errorOutput('Usage: notebooks add <url>');
      process.exit(1);
    }

    const id = extractNotebookId(urlOrId);
    const name = (parsed.flags.name as string) ?? id;
    const description = parsed.flags.description as string | undefined;
    const url = urlOrId.startsWith('http') ? urlOrId : `https://notebooklm.google.com/notebook/${id}`;

    await addNotebook({ id, name, url, description });
    textOutput(`Added notebook "${name}" (${id})`);
    return;
  }

  if (sub === 'remove') {
    const id = parsed.positional[0];
    if (!id) {
      errorOutput('Usage: notebooks remove <id>');
      process.exit(1);
    }
    await removeNotebook(id);
    textOutput(`Removed notebook "${id}"`);
    return;
  }

  if (sub === 'activate') {
    const id = parsed.positional[0];
    if (!id) {
      errorOutput('Usage: notebooks activate <id>');
      process.exit(1);
    }
    await setActiveNotebook(id);
    textOutput(`Activated notebook "${id}"`);
    return;
  }

  if (sub === 'search') {
    const query = parsed.positional[0];
    if (!query) {
      errorOutput('Usage: notebooks search <query>');
      process.exit(1);
    }
    const results = await searchNotebooks(query);
    if (isJson) {
      jsonOutput(results);
      return;
    }
    if (results.length === 0) {
      textOutput(`No notebooks matching "${query}"`);
      return;
    }
    textOutput(`Found ${results.length} notebook(s):\n`);
    for (const nb of results) {
      textOutput(`  ${nb.id} — ${nb.name}`);
      if (nb.description) textOutput(`    ${nb.description}`);
    }
    return;
  }

  errorOutput(`Unknown notebooks subcommand: ${sub}`);
  process.exit(1);
}

async function handleGenerate(parsed: ParsedArgs): Promise<void> {
  const type = parsed.subcommand as ArtifactType | undefined;
  if (!type) {
    errorOutput('Usage: generate <type> [options]\nTypes: audio, video, report, quiz, flashcards, mind_map, infographic, slide_deck, data_table');
    process.exit(1);
  }

  const validTypes: ArtifactType[] = [
    'audio', 'video', 'report', 'quiz', 'flashcards',
    'mind_map', 'infographic', 'slide_deck', 'data_table',
  ];
  if (!validTypes.includes(type)) {
    errorOutput(`Unknown artifact type: ${type}\nValid types: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  const isJson = parsed.flags.json === true;

  // Resolve notebook
  let notebookId: string;
  const notebookFlag = parsed.flags.notebook as string | undefined;
  if (notebookFlag) {
    notebookId = extractNotebookId(notebookFlag);
  } else {
    const active = await getActiveNotebook();
    if (!active) {
      errorOutput(
        'No notebook specified and no active notebook set.\n' +
          'Use --notebook <url|id> or run: notebooks activate <id>',
      );
      process.exit(1);
    }
    notebookId = active.id;
  }

  // Load cookies and init RPC client
  const cookieMap = await readCookieMapFromDisk({
    log: (msg) => {
      if (!isJson) textOutput(msg);
    },
  });

  if (!hasRequiredCookies(cookieMap)) {
    errorOutput('No valid cookies found. Run "login" first to authenticate with Google.');
    process.exit(1);
  }

  const rpc = new RPCClient(cookieMap);
  if (!isJson) textOutput('Initializing RPC client...');
  await rpc.init();

  // Fetch notebook sources via LIST_NOTEBOOKS
  if (!isJson) textOutput('Fetching notebook sources...');
  let sourceIds: string[] = [];
  try {
    const listData = await rpc.execute(RPC.LIST_NOTEBOOKS, [null, 1, null, [2]]);
    // Response: [[notebooks_array]]
    // notebooks_array: [notebook1, notebook2, ...]
    // Each notebook: ["title", [[["sourceId"], "name", ...], ...], "notebookId", "emoji", ...]
    if (Array.isArray(listData) && Array.isArray(listData[0])) {
      const allNotebooks = listData[0] as unknown[][];
      for (const nb of allNotebooks) {
        if (!Array.isArray(nb)) continue;
        // Find our notebook by checking if notebookId appears as a string in the entry
        const nbJson = JSON.stringify(nb);
        if (!nbJson.includes(notebookId)) continue;
        // Sources are at nb[1] as [[["sourceId"], "sourceName", ...], ...]
        const sources = Array.isArray(nb[1]) ? nb[1] as unknown[][] : [];
        for (const source of sources) {
          if (!Array.isArray(source)) continue;
          // source[0] = [["sourceId"]] or ["sourceId"]
          const idHolder = source[0];
          if (Array.isArray(idHolder)) {
            const id = Array.isArray(idHolder[0]) ? idHolder[0] as string : idHolder as unknown as string;
            const actualId = typeof id === 'string' ? id : (Array.isArray(id) ? (id as unknown[])[0] : null);
            if (typeof actualId === 'string' && actualId.length > 10 && !sourceIds.includes(actualId)) {
              sourceIds.push(actualId);
            }
          }
        }
        break; // Found our notebook
      }
    }
    if (!isJson) textOutput(`Found ${sourceIds.length} source(s)`);
  } catch (err) {
    if (!isJson) textOutput(`Warning: Could not fetch sources: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Build artifact config — only assign format/length flags to the matching type
  const formatFlag = parsed.flags.format as string | undefined;
  const lengthFlag = parsed.flags.length as string | undefined;

  const config: ArtifactConfig = {
    type,
    notebookId,
    sourceIds,
    instructions: parsed.flags.instructions as string | undefined,
    language: (parsed.flags.language as string) ?? 'en',
    audioFormat: type === 'audio' ? formatFlag as ArtifactConfig['audioFormat'] : undefined,
    audioLength: type === 'audio' ? lengthFlag as ArtifactConfig['audioLength'] : undefined,
    videoStyle: parsed.flags.style as ArtifactConfig['videoStyle'],
    videoFormat: type === 'video' ? formatFlag as ArtifactConfig['videoFormat'] : undefined,
    difficulty: parsed.flags.difficulty as ArtifactConfig['difficulty'],
    quantity: parsed.flags.quantity as ArtifactConfig['quantity'],
    slideDeckFormat: type === 'slide_deck' ? formatFlag as ArtifactConfig['slideDeckFormat'] : undefined,
    slideDeckLength: type === 'slide_deck' ? lengthFlag as ArtifactConfig['slideDeckLength'] : undefined,
    infographicOrientation: parsed.flags.orientation as ArtifactConfig['infographicOrientation'],
    infographicDetail: parsed.flags.detail as ArtifactConfig['infographicDetail'],
    reportFormat: type === 'report' ? formatFlag as ArtifactConfig['reportFormat'] : undefined,
  };

  // Determine output path
  const outputPath = resolveOutputPath(type, parsed.flags.output as string | undefined);

  // Generate
  const generator = new ArtifactGenerator(rpc);
  if (!isJson) textOutput(`\nGenerating ${type}...`);

  try {
    const result = await generator.createAndWait(config, outputPath);
    await recordUsage(notebookId);

    if (isJson) {
      jsonOutput(result);
    } else {
      textOutput(`\nArtifact generated successfully!`);
      textOutput(`  Type:   ${result.type}`);
      textOutput(`  Status: ${result.status}`);
      if (result.title) textOutput(`  Title:  ${result.title}`);
      if (result.filePath) textOutput(`  File:   ${result.filePath}`);
      if (result.downloadUrl) textOutput(`  URL:    ${result.downloadUrl}`);
      if (result.downloadError) {
        textOutput(`\n  Note: Auto-download failed. Open the URL above in your browser to download.`);
        textOutput(`  Reason: ${result.downloadError}`);
      }
      if (result.content && !result.filePath) {
        textOutput(`\n--- Content ---\n`);
        textOutput(result.content.slice(0, 2000));
        if (result.content.length > 2000) {
          textOutput(`\n... (${result.content.length} characters total)`);
        }
      }
    }
  } catch (err) {
    if (isJson) {
      jsonOutput({ error: err instanceof Error ? err.message : String(err) });
    } else {
      errorOutput(`Generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared: resolve notebook + RPC init
// ---------------------------------------------------------------------------

/**
 * Common bootstrap used by chat, sources, research, and notes handlers.
 * Resolves the notebook ID (from --notebook flag or active notebook),
 * loads cookies, verifies auth, initialises the RPCClient, and fetches
 * the source IDs for the notebook.
 */
async function resolveNotebookAndRpc(
  parsed: ParsedArgs,
  isJson: boolean,
): Promise<{ notebookId: string; rpc: RPCClient; sourceIds: string[] }> {
  // 1. Resolve notebook ID
  let notebookId: string;
  const notebookFlag = parsed.flags.notebook as string | undefined;
  if (notebookFlag) {
    notebookId = extractNotebookId(notebookFlag);
  } else {
    const active = await getActiveNotebook();
    if (!active) {
      errorOutput(
        'No notebook specified and no active notebook set.\n' +
          'Use --notebook <url|id> or run: notebooks activate <id>',
      );
      process.exit(1);
    }
    notebookId = active.id;
  }

  // 2. Load cookies
  const cookieMap = await readCookieMapFromDisk({
    log: (msg) => {
      if (!isJson) textOutput(msg);
    },
  });

  if (!hasRequiredCookies(cookieMap)) {
    errorOutput('No valid cookies found. Run "login" first to authenticate with Google.');
    process.exit(1);
  }

  // 3. Init RPC client
  const rpc = new RPCClient(cookieMap);
  if (!isJson) textOutput('Initializing RPC client...');
  await rpc.init();

  // 4. Fetch source IDs for the notebook
  let sourceIds: string[] = [];
  try {
    const listData = await rpc.execute(RPC.LIST_NOTEBOOKS, [null, 1, null, [2]]);
    if (Array.isArray(listData) && Array.isArray(listData[0])) {
      const allNotebooks = listData[0] as unknown[][];
      for (const nb of allNotebooks) {
        if (!Array.isArray(nb)) continue;
        const nbJson = JSON.stringify(nb);
        if (!nbJson.includes(notebookId)) continue;
        const sources = Array.isArray(nb[1]) ? (nb[1] as unknown[][]) : [];
        for (const source of sources) {
          if (!Array.isArray(source)) continue;
          const idHolder = source[0];
          if (Array.isArray(idHolder)) {
            const id = Array.isArray(idHolder[0]) ? (idHolder[0] as string) : (idHolder as unknown as string);
            const actualId = typeof id === 'string' ? id : Array.isArray(id) ? (id as unknown[])[0] : null;
            if (typeof actualId === 'string' && actualId.length > 10 && !sourceIds.includes(actualId)) {
              sourceIds.push(actualId);
            }
          }
        }
        break;
      }
    }
    if (!isJson) textOutput(`Found ${sourceIds.length} source(s)`);
  } catch (err) {
    if (!isJson)
      textOutput(`Warning: Could not fetch sources: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { notebookId, rpc, sourceIds };
}

// ---------------------------------------------------------------------------
// Chat command
// ---------------------------------------------------------------------------

async function handleChat(parsed: ParsedArgs): Promise<void> {
  const isJson = parsed.flags.json === true;
  const question = parsed.flags.question as string | undefined;

  if (!question) {
    errorOutput('Usage: chat --notebook <url|id> --question "your question" [--conversation-id <id>] [--json]');
    process.exit(1);
  }

  const { notebookId, rpc, sourceIds } = await resolveNotebookAndRpc(parsed, isJson);
  const conversationId = parsed.flags['conversation-id'] as string | undefined;

  if (!isJson) textOutput(`\nSending question to notebook ${notebookId}...`);

  try {
    const result = await chat({
      notebookId,
      question,
      sourceIds,
      conversationId,
      cookieMap: rpc.getCookieMap(),
      csrfToken: rpc.getCsrfToken(),
      sessionId: rpc.getSessionId(),
      log: isJson ? undefined : (msg: string) => textOutput(msg),
    });

    await recordUsage(notebookId);

    if (isJson) {
      jsonOutput(result);
    } else {
      textOutput(`\n--- Answer ---\n`);
      textOutput(result.answer);
      if (result.citations.length > 0) {
        textOutput(`\n--- Citations (${result.citations.length}) ---`);
        for (const cite of result.citations) {
          textOutput(`  [${cite.sourceId}] ${cite.text}`);
        }
      }
      textOutput(`\nConversation ID: ${result.conversationId}`);
      textOutput('(Use --conversation-id to continue this conversation)');
    }
  } catch (err) {
    if (isJson) {
      jsonOutput({ error: err instanceof Error ? err.message : String(err) });
    } else {
      errorOutput(`Chat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sources commands
// ---------------------------------------------------------------------------

async function handleSources(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand;
  const isJson = parsed.flags.json === true;

  if (!sub || sub === 'list') {
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nFetching sources for notebook ${notebookId}...`);

    try {
      const sources = await listSources(rpc, notebookId);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(sources);
      } else {
        if (sources.length === 0) {
          textOutput('No sources in this notebook.');
        } else {
          textOutput(`\nSources (${sources.length}):\n`);
          for (const src of sources) {
            textOutput(`  ${src.id}`);
            if (src.title) textOutput(`    Title: ${src.title}`);
            if (src.type) textOutput(`    Type:  ${src.type}`);
            textOutput('');
          }
        }
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to list sources: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'add-url') {
    const url = parsed.positional[0];
    if (!url) {
      errorOutput('Usage: sources add-url <url> --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nAdding URL source: ${url}`);

    try {
      const result = await addSourceUrl(rpc, notebookId, url);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(result);
      } else {
        textOutput(`Source added successfully.`);
        if (result.id) textOutput(`  Source ID: ${result.id}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to add URL source: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'add-youtube') {
    const url = parsed.positional[0];
    if (!url) {
      errorOutput('Usage: sources add-youtube <url> --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nAdding YouTube source: ${url}`);

    try {
      const result = await addSourceYouTube(rpc, notebookId, url);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(result);
      } else {
        textOutput(`YouTube source added successfully.`);
        if (result.id) textOutput(`  Source ID: ${result.id}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to add YouTube source: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'add-text') {
    const title = parsed.flags.title as string | undefined;
    const content = parsed.flags.content as string | undefined;
    if (!title || !content) {
      errorOutput('Usage: sources add-text --title "title" --content "text" --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nAdding text source: "${title}"`);

    try {
      const result = await addSourceText(rpc, notebookId, title, content);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(result);
      } else {
        textOutput(`Text source added successfully.`);
        if (result.id) textOutput(`  Source ID: ${result.id}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to add text source: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'add-file') {
    const filePath = parsed.positional[0];
    if (!filePath) {
      errorOutput('Usage: sources add-file <filepath> --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    const resolvedPath = path.resolve(filePath);
    if (!isJson) textOutput(`\nAdding file source: ${resolvedPath}`);

    // Read file contents
    let fileBuffer: Buffer;
    try {
      fileBuffer = await readFile(resolvedPath);
    } catch (err) {
      errorOutput(`Cannot read file "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const fileName = path.basename(resolvedPath);

    try {
      const result = await addSourceFile(rpc, notebookId, filePath, rpc.getCookieMap());
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(result);
      } else {
        textOutput(`File source added successfully.`);
        if (result.id) textOutput(`  Source ID: ${result.id}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to add file source: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'delete') {
    const sourceId = parsed.positional[0];
    if (!sourceId) {
      errorOutput('Usage: sources delete <sourceId> --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nDeleting source ${sourceId}...`);

    try {
      await deleteSource(rpc, notebookId, sourceId);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput({ success: true, sourceId });
      } else {
        textOutput(`Source "${sourceId}" deleted successfully.`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to delete source: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  errorOutput(`Unknown sources subcommand: ${sub}`);
  errorOutput('Valid subcommands: list, add-url, add-youtube, add-text, add-file, delete');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Research commands
// ---------------------------------------------------------------------------

async function handleResearch(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand;
  const isJson = parsed.flags.json === true;

  if (sub === 'fast' || sub === 'deep') {
    const query = parsed.flags.query as string | undefined;
    if (!query) {
      errorOutput(`Usage: research ${sub} --query "topic" --notebook <url|id> [--import] [--json]`);
      process.exit(1);
    }

    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    const shouldImport = parsed.flags.import === true;

    if (!isJson) textOutput(`\nStarting ${sub} research: "${query}"`);

    try {
      // Start research
      const startFn = sub === 'fast' ? startFastResearch : startDeepResearch;
      const researchResult = await startFn(rpc, notebookId, query);

      if (!isJson) textOutput('Research started. Polling for completion...');

      // Poll until complete
      const pollIntervalMs = sub === 'deep' ? 5000 : 3000;
      const maxAttempts = sub === 'deep' ? 120 : 60; // 10 min deep, 3 min fast
      let status = researchResult;
      let attempts = 0;

      while (status.status !== 'completed' && status.status !== 'failed' && attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        attempts++;
        if (!isJson) textOutput(`  Polling... (attempt ${attempts}/${maxAttempts})`);
        status = await pollResearch(rpc, notebookId);
      }

      if (status.status === 'failed') {
        throw new Error('Research failed. The server returned a failure status.');
      }

      if (attempts >= maxAttempts) {
        throw new Error(`Research timed out after ${maxAttempts} poll attempts. Use "research status" to check later.`);
      }

      // Optionally import found sources
      if (shouldImport && status.status === 'completed') {
        if (!isJson) textOutput('\nImporting research sources into notebook...');
        await importResearch(rpc, notebookId, status.taskId || researchResult.taskId, status.sources || []);
        if (!isJson) textOutput('Sources imported successfully.');
      }

      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(status);
      } else {
        textOutput(`\nResearch completed!`);
        if (status.summary) textOutput(`\nSummary: ${status.summary}`);
        if (status.sourcesFound !== undefined) textOutput(`Sources found: ${status.sourcesFound}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Research failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'status') {
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nChecking research status for notebook ${notebookId}...`);

    try {
      const status = await pollResearch(rpc, notebookId);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(status);
      } else {
        textOutput(`\nResearch status: ${status.status}`);
        if (status.summary) textOutput(`Summary: ${status.summary}`);
        if (status.sourcesFound !== undefined) textOutput(`Sources found: ${status.sourcesFound}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to get research status: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  errorOutput('Usage: research <fast|deep|status> [options]');
  errorOutput('  research fast --query "topic" --notebook <url|id> [--import] [--json]');
  errorOutput('  research deep --query "topic" --notebook <url|id> [--import] [--json]');
  errorOutput('  research status --notebook <url|id> [--json]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Notes commands
// ---------------------------------------------------------------------------

async function handleNotes(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand;
  const isJson = parsed.flags.json === true;

  if (!sub || sub === 'list') {
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nFetching notes for notebook ${notebookId}...`);

    try {
      const notes = await listNotes(rpc, notebookId);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(notes);
      } else {
        if (notes.length === 0) {
          textOutput('No notes in this notebook.');
        } else {
          textOutput(`\nNotes (${notes.length}):\n`);
          for (const note of notes) {
            textOutput(`  ${note.id}`);
            if (note.title) textOutput(`    Title: ${note.title}`);
            if (note.content) textOutput(`    Content: ${note.content.slice(0, 100)}${note.content.length > 100 ? '...' : ''}`);
            textOutput('');
          }
        }
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to list notes: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'create') {
    const title = parsed.flags.title as string | undefined;
    const content = parsed.flags.content as string | undefined;
    if (!title || !content) {
      errorOutput('Usage: notes create --title "title" --content "content" --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nCreating note: "${title}"`);

    try {
      const result = await createNote(rpc, notebookId, title, content);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(result);
      } else {
        textOutput(`Note created successfully.`);
        if (result.id) textOutput(`  Note ID: ${result.id}`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to create note: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'update') {
    const noteId = parsed.positional[0];
    if (!noteId) {
      errorOutput('Usage: notes update <noteId> --title "new title" --content "new content" --notebook <url|id>');
      process.exit(1);
    }
    const title = parsed.flags.title as string | undefined;
    const content = parsed.flags.content as string | undefined;
    if (!title && !content) {
      errorOutput('At least one of --title or --content must be provided.');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nUpdating note ${noteId}...`);

    try {
      const result = await updateNote(rpc, notebookId, noteId, title ?? '', content ?? '');
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput(result);
      } else {
        textOutput(`Note "${noteId}" updated successfully.`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to update note: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  if (sub === 'delete') {
    const noteId = parsed.positional[0];
    if (!noteId) {
      errorOutput('Usage: notes delete <noteId> --notebook <url|id>');
      process.exit(1);
    }
    const { notebookId, rpc } = await resolveNotebookAndRpc(parsed, isJson);
    if (!isJson) textOutput(`\nDeleting note ${noteId}...`);

    try {
      await deleteNote(rpc, notebookId, noteId);
      await recordUsage(notebookId);

      if (isJson) {
        jsonOutput({ success: true, noteId });
      } else {
        textOutput(`Note "${noteId}" deleted successfully.`);
      }
    } catch (err) {
      if (isJson) {
        jsonOutput({ error: err instanceof Error ? err.message : String(err) });
      } else {
        errorOutput(`Failed to delete note: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  errorOutput(`Unknown notes subcommand: ${sub}`);
  errorOutput('Valid subcommands: list, create, update, delete');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts source IDs from a GET_NOTEBOOK response.
 * The response structure is deeply nested; sources are typically
 * found as arrays of [sourceId] within the notebook data.
 */
function extractSourceIds(data: unknown): string[] {
  const ids: string[] = [];

  function walk(node: unknown, depth: number): void {
    if (depth > 10) return;
    if (Array.isArray(node)) {
      // A source entry often looks like [[sourceId]] or [sourceId, ...]
      // where sourceId is a long string
      if (
        node.length >= 1 &&
        typeof node[0] === 'string' &&
        node[0].length >= 20 &&
        /^[a-zA-Z0-9_-]+$/.test(node[0])
      ) {
        // Check if this looks like a source ID (not a notebook ID or other token)
        // Source IDs are typically in arrays that also contain source metadata
        if (!ids.includes(node[0])) {
          ids.push(node[0]);
        }
      }
      for (const item of node) {
        walk(item, depth + 1);
      }
    }
  }

  walk(data, 0);

  // If we found too many IDs, we may have over-captured.
  // The notebook ID itself will often appear; filter it out.
  // In practice, the first few IDs are the most relevant.
  return ids;
}

/** Builds an output file path based on artifact type and optional user override. */
function resolveOutputPath(type: ArtifactType, userPath?: string): string {
  if (userPath) {
    return path.resolve(userPath);
  }

  const outputDir = resolveOutputDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const extensions: Record<string, string> = {
    audio: '.m4a',
    video: '.mp4',
    report: '.md',
    quiz: '.html',
    flashcards: '.html',
    mind_map: '.html',
    infographic: '.png',
    slide_deck: '.pptx',
    data_table: '.json',
  };

  const ext = extensions[type] ?? '.txt';
  return path.join(outputDir, `${type}-${timestamp}${ext}`);
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  textOutput(`Usage: npx -y bun scripts/main.ts <command> [options]

Commands:
  login                    Authenticate with Google (opens Chrome)
  notebooks list           List saved notebooks
  notebooks add <url>      Add a notebook to library
  notebooks remove <id>    Remove a notebook
  notebooks activate <id>  Set active notebook
  generate <type>          Generate an artifact
  chat                     Chat with the notebook AI
  sources <sub>            Manage notebook sources
  research <sub>           Run fast or deep research
  notes <sub>              Manage notebook notes

Chat options:
  chat --notebook <url|id> --question "your question" [--conversation-id <id>] [--json]

Sources subcommands:
  sources list                           List sources in a notebook
  sources add-url <url>                  Add a web URL as a source
  sources add-youtube <url>              Add a YouTube video as a source
  sources add-text --title "t" --content "c"  Add inline text as a source
  sources add-file <filepath>            Upload a file as a source
  sources delete <sourceId>              Delete a source

Research subcommands:
  research fast --query "topic"          Start fast research (polls until done)
  research deep --query "topic"          Start deep research (polls until done)
  research status                        Check current research status
  Options: --import (auto-import found sources)  --json

Notes subcommands:
  notes list                             List notes in a notebook
  notes create --title "t" --content "c" Create a new note
  notes update <noteId> [--title "t"] [--content "c"]  Update a note
  notes delete <noteId>                  Delete a note

Generate options:
  --notebook <url|id>      Notebook URL or library ID (defaults to active)
  --output <path>          Output file path
  --instructions <text>    Custom instructions for generation
  --language <code>        Language code (default: en)
  --json                   Output as JSON

  Audio:    --format deep_dive|brief|critique|debate  --length short|default|long
  Video:    --style auto|classic|whiteboard|kawaii|anime|watercolor  --format explainer|brief
  Slides:   --format detailed|presenter  --length default|short
  Quiz:     --difficulty easy|medium|hard  --quantity fewer|standard|more
  Infographic: --orientation landscape|portrait|square  --detail concise|standard|detailed
  Report:   --format briefing|study_guide|blog_post|custom

Common options:
  --notebook <url|id>      Notebook URL or library ID (defaults to active)
  --json                   Output as JSON

Examples:
  npx -y bun scripts/main.ts login
  npx -y bun scripts/main.ts chat --notebook xxx --question "Summarize the key points"
  npx -y bun scripts/main.ts sources add-url https://example.com/article --notebook xxx
  npx -y bun scripts/main.ts research fast --query "machine learning" --notebook xxx --import
  npx -y bun scripts/main.ts notes create --title "Key Ideas" --content "..." --notebook xxx
  npx -y bun scripts/main.ts generate audio --notebook https://notebooklm.google.com/notebook/xxx
  npx -y bun scripts/main.ts generate slide_deck --instructions "Focus on key metrics" --output slides.pdf
  npx -y bun scripts/main.ts generate quiz --difficulty medium --quantity more --json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.command || parsed.command === 'help' || parsed.flags.help === true) {
    printUsage();
    return;
  }

  switch (parsed.command) {
    case 'login':
      await handleLogin(parsed);
      break;
    case 'notebooks':
      await handleNotebooks(parsed);
      break;
    case 'generate':
      await handleGenerate(parsed);
      break;
    case 'chat':
      await handleChat(parsed);
      break;
    case 'sources':
      await handleSources(parsed);
      break;
    case 'research':
      await handleResearch(parsed);
      break;
    case 'notes':
      await handleNotes(parsed);
      break;
    default:
      errorOutput(`Unknown command: ${parsed.command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  errorOutput(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
