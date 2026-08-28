import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactConfig, ArtifactResult, ArtifactType } from './types.js';
import { RPCClient } from './rpc-client.js';
import {
  RPC,
  APP_VARIANT,
  ARTIFACT_STATUS,
  ARTIFACT_TYPE_CODE,
  AUDIO_FORMAT,
  AUDIO_LENGTH,
  INFOGRAPHIC_DETAIL,
  INFOGRAPHIC_ORIENTATION,
  INFOGRAPHIC_STYLE,
  QUIZ_DIFFICULTY,
  QUIZ_QUANTITY,
  REPORT_PRESETS,
  SLIDE_FORMAT,
  SLIDE_LENGTH,
  VIDEO_FORMAT,
  VIDEO_STYLE,
  artifactClientOptions,
} from './rpc-types.js';

// ---------------------------------------------------------------------------
// LIST_ARTIFACTS row layout (positions verified against live captures)
// ---------------------------------------------------------------------------
//   [0] id            [1] title        [2] type code     [3] sources
//   [4] status        [6] audio meta   [7] report md     [8] video meta
//   [9] options (variant at [9][1][0]) [14] infographic  [16] slide deck
//   [18] data table payload
const ROW = {
  ID: 0,
  TITLE: 1,
  TYPE: 2,
  STATUS: 4,
  AUDIO: 6,
  REPORT: 7,
  VIDEO: 8,
  OPTIONS: 9,
  INFOGRAPHIC: 14,
  SLIDES: 16,
  DATA_TABLE: 18,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps each id as [[id]] (depth-2 nesting used in artifact descriptors). */
export function tripleNest(ids: string[]): string[][][] {
  return ids.map((id) => [[id]]);
}

/** Wraps each id as [id]. */
export function doubleNest(ids: string[]): string[][] {
  return ids.map((id) => [id]);
}

function isHttp(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('http');
}

/** Recursively searches a nested structure for the first string that starts with "http". */
function findUrlInNested(data: unknown, depth = 0): string | undefined {
  if (depth > 12) return undefined;
  if (isHttp(data)) return data;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUrlInNested(item, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function resolveStatus(code: number): ArtifactResult['status'] {
  switch (code) {
    case ARTIFACT_STATUS.PENDING:
      return 'pending';
    case ARTIFACT_STATUS.PROCESSING:
    case ARTIFACT_STATUS.PENDING_REVIEW:
      return 'processing';
    case ARTIFACT_STATUS.COMPLETED:
      return 'completed';
    case ARTIFACT_STATUS.FAILED:
      return 'failed';
    default:
      return 'processing';
  }
}

export interface ArtifactRow {
  id: string;
  title: string;
  typeCode: number;
  status: number;
  type: ArtifactType;
  raw: unknown[];
}

/** Maps a LIST_ARTIFACTS row to its artifact type, using the type-4 variant when needed. */
export function inferArtifactType(row: unknown[]): ArtifactType {
  const code = row[ROW.TYPE];
  switch (code) {
    case ARTIFACT_TYPE_CODE.audio:
      return 'audio';
    case ARTIFACT_TYPE_CODE.report:
      return 'report';
    case ARTIFACT_TYPE_CODE.video:
      return 'video';
    case ARTIFACT_TYPE_CODE.infographic:
      return 'infographic';
    case ARTIFACT_TYPE_CODE.slide_deck:
      return 'slide_deck';
    case ARTIFACT_TYPE_CODE.data_table:
      return 'data_table';
    case ARTIFACT_TYPE_CODE.quiz: {
      const options = row[ROW.OPTIONS];
      const variant = Array.isArray(options) && Array.isArray(options[1]) ? options[1][0] : undefined;
      if (variant === APP_VARIANT.flashcards) return 'flashcards';
      if (variant === APP_VARIANT.mind_map) return 'mind_map';
      return 'quiz';
    }
    default:
      return 'report';
  }
}

/** Parses one LIST_ARTIFACTS row; returns null for anything that isn't an artifact row. */
export function parseArtifactRow(entry: unknown): ArtifactRow | null {
  if (!Array.isArray(entry) || typeof entry[ROW.ID] !== 'string' || entry[ROW.ID].length < 8) return null;
  const typeCode = typeof entry[ROW.TYPE] === 'number' ? (entry[ROW.TYPE] as number) : 0;
  const status = typeof entry[ROW.STATUS] === 'number' ? (entry[ROW.STATUS] as number) : 0;
  return {
    id: entry[ROW.ID] as string,
    title: typeof entry[ROW.TITLE] === 'string' ? (entry[ROW.TITLE] as string) : '',
    typeCode,
    status,
    type: inferArtifactType(entry),
    raw: entry,
  };
}

/**
 * Extracts artifact rows from a LIST_ARTIFACTS response.
 * The payload is `[[row, row, ...], ...]`; a bare row list is tolerated too.
 */
export function parseArtifactList(data: unknown): ArtifactRow[] {
  if (!Array.isArray(data)) return [];
  const container = Array.isArray(data[0]) && Array.isArray((data[0] as unknown[])[0]) ? (data[0] as unknown[]) : data;
  const rows: ArtifactRow[] = [];
  for (const item of container) {
    const row = parseArtifactRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// URL / content extractors (all take the raw row)
// ---------------------------------------------------------------------------

/** Audio: row[6][5] is a media list of [url, kind, mime]; prefer audio/mp4. */
export function extractAudioUrl(row: unknown[]): string | undefined {
  const meta = row[ROW.AUDIO];
  if (!Array.isArray(meta)) return undefined;
  const media = meta[5];
  if (Array.isArray(media)) {
    const entries = media.filter((m): m is unknown[] => Array.isArray(m) && isHttp(m[0]));
    const mp4 = entries.find((m) => m[2] === 'audio/mp4');
    if (mp4) return mp4[0] as string;
    if (entries.length) return entries[0][0] as string;
  }
  return findUrlInNested(meta);
}

/** Video: row[8][4] is a media list of [url, kind, mime]; prefer video/mp4 with kind 4 (download). */
export function extractVideoUrl(row: unknown[]): string | undefined {
  const meta = row[ROW.VIDEO];
  if (!Array.isArray(meta)) return undefined;
  const media = meta[4];
  if (Array.isArray(media)) {
    const entries = media.filter((m): m is unknown[] => Array.isArray(m) && isHttp(m[0]));
    const best =
      entries.find((m) => m[2] === 'video/mp4' && m[1] === 4) ??
      entries.find((m) => m[2] === 'video/mp4') ??
      entries[0];
    if (best) return best[0] as string;
  }
  return findUrlInNested(meta);
}

/** Slides: row[16][3] = PDF URL, row[16][4] = PPTX URL. */
export function extractSlideUrls(row: unknown[]): { pdf?: string; pptx?: string } {
  const meta = row[ROW.SLIDES];
  if (!Array.isArray(meta)) return {};
  return {
    pdf: isHttp(meta[3]) ? meta[3] : undefined,
    pptx: isHttp(meta[4]) ? meta[4] : undefined,
  };
}

/** Infographic: row[14][2][*][1][0] is the image URL. */
export function extractInfographicUrl(row: unknown[]): string | undefined {
  const meta = row[ROW.INFOGRAPHIC];
  if (!Array.isArray(meta)) return undefined;
  const items = meta[2];
  if (Array.isArray(items)) {
    for (const item of items) {
      const img = Array.isArray(item) ? item[1] : undefined;
      if (Array.isArray(img) && isHttp(img[0])) return img[0];
    }
  }
  return findUrlInNested(meta);
}

/** Report: row[7] is the markdown string (or [markdown]). */
export function extractReportContent(row: unknown[]): string | undefined {
  const section = row[ROW.REPORT];
  if (typeof section === 'string') return section;
  if (Array.isArray(section) && typeof section[0] === 'string') return section[0];
  return undefined;
}

/** Concatenates every string leaf in a rich-text cell (integers are position markers). */
function extractCellText(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (Array.isArray(cell)) return cell.map(extractCellText).join('');
  return '';
}

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Data table: row[18] holds a rich-text document; rows live at
 * payload[0][0][0][0][4][2] as `[start, end, [cell, ...]]`, first row = headers.
 */
export function parseDataTable(payload: unknown): { headers: string[]; rows: string[][] } | undefined {
  const rowsArray = (payload as unknown[][][][][][][])?.[0]?.[0]?.[0]?.[0]?.[4]?.[2];
  if (!Array.isArray(rowsArray) || rowsArray.length === 0) return undefined;
  let headers: string[] = [];
  const rows: string[][] = [];
  rowsArray.forEach((section, i) => {
    if (!Array.isArray(section) || !Array.isArray(section[2])) return;
    const values = (section[2] as unknown[]).map(extractCellText);
    if (i === 0) headers = values;
    else rows.push(values);
  });
  if (!headers.length) return undefined;
  return { headers, rows };
}

export function dataTableToCsv(table: { headers: string[]; rows: string[][] }): string {
  return [table.headers, ...table.rows].map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Param builders (exported for tests)
// ---------------------------------------------------------------------------

function descriptor(typeCode: number, sourceIds: string[], slots: Record<number, unknown>): unknown[] {
  const maxIdx = Math.max(3, ...Object.keys(slots).map(Number));
  const desc: unknown[] = new Array(maxIdx + 1).fill(null);
  desc[2] = typeCode;
  desc[3] = tripleNest(sourceIds);
  for (const [idx, value] of Object.entries(slots)) desc[Number(idx)] = value;
  return desc;
}

function createParams(notebookId: string, desc: unknown[]): unknown[] {
  return [artifactClientOptions(), notebookId, desc];
}

export function buildAudioParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  const format = AUDIO_FORMAT[config.audioFormat ?? 'deep_dive'];
  const length = AUDIO_LENGTH[config.audioLength ?? 'default'];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.audio, ids, {
      6: [null, [config.instructions ?? null, length, null, doubleNest(ids), config.language ?? 'en', null, format]],
    }),
  );
}

export function buildVideoParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  const format = VIDEO_FORMAT[config.videoFormat ?? 'explainer'];
  const styleKey = config.videoStyle ?? 'auto';
  const style = VIDEO_STYLE[styleKey];
  const inner: unknown[] = [doubleNest(ids), config.language ?? 'en', config.instructions ?? null, null, format];
  if (format !== VIDEO_FORMAT.cinematic) {
    inner.push(styleKey === 'custom' ? null : style);
    if (styleKey === 'custom' && config.videoStylePrompt) inner.push(config.videoStylePrompt);
  }
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.video, ids, { 8: [null, null, inner] }),
  );
}

export function buildReportParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  const key = config.reportFormat ?? 'briefing';
  const preset = REPORT_PRESETS[key] ?? REPORT_PRESETS.briefing;
  let prompt: string = key === 'custom' ? (config.reportPrompt ?? config.instructions ?? preset.prompt) : preset.prompt;
  if (key !== 'custom' && config.instructions) prompt = `${prompt}\n\n${config.instructions}`;
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.report, ids, {
      7: [null, [preset.title, preset.description, null, doubleNest(ids), config.language ?? 'en', prompt, null, true]],
    }),
  );
}

/** Both quiz and flashcards carry `[quantity, difficulty]` — quantity first. */
function quizOptionPair(config: ArtifactConfig): [number, number] {
  return [QUIZ_QUANTITY[config.quantity ?? 'standard'], QUIZ_DIFFICULTY[config.difficulty ?? 'medium']];
}

export function buildQuizParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.quiz, ids, {
      9: [null, [APP_VARIANT.quiz, null, config.instructions ?? null, null, null, null, null, quizOptionPair(config)]],
    }),
  );
}

export function buildFlashcardsParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.flashcards, ids, {
      9: [null, [APP_VARIANT.flashcards, null, config.instructions ?? null, null, null, null, quizOptionPair(config)]],
    }),
  );
}

/** Interactive (studio) mind map — a real artifact that shows up in LIST_ARTIFACTS. */
export function buildMindMapParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  const instructions = config.instructions?.trim();
  const options: unknown[] = instructions ? [APP_VARIANT.mind_map, null, instructions] : [APP_VARIANT.mind_map];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.mind_map, ids, { 9: [null, options] }),
  );
}

export function buildSlideDeckParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.slide_deck, ids, {
      16: [[
        config.instructions ?? null,
        config.language ?? 'en',
        SLIDE_FORMAT[config.slideDeckFormat ?? 'detailed'],
        SLIDE_LENGTH[config.slideDeckLength ?? 'default'],
      ]],
    }),
  );
}

export function buildInfographicParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.infographic, ids, {
      14: [[
        config.instructions ?? null,
        config.language ?? 'en',
        null,
        INFOGRAPHIC_ORIENTATION[config.infographicOrientation ?? 'landscape'],
        INFOGRAPHIC_DETAIL[config.infographicDetail ?? 'standard'],
        INFOGRAPHIC_STYLE[config.infographicStyle ?? 'auto'],
      ]],
    }),
  );
}

export function buildDataTableParams(config: ArtifactConfig): unknown[] {
  const ids = config.sourceIds ?? [];
  return createParams(
    config.notebookId,
    descriptor(ARTIFACT_TYPE_CODE.data_table, ids, {
      18: [null, [config.instructions ?? null, config.language ?? 'en']],
    }),
  );
}

export const PARAM_BUILDERS: Record<ArtifactType, (c: ArtifactConfig) => unknown[]> = {
  audio: buildAudioParams,
  video: buildVideoParams,
  report: buildReportParams,
  quiz: buildQuizParams,
  flashcards: buildFlashcardsParams,
  mind_map: buildMindMapParams,
  slide_deck: buildSlideDeckParams,
  infographic: buildInfographicParams,
  data_table: buildDataTableParams,
};

/** Media artifacts flip to COMPLETED before their download URL lands; keep polling until it does. */
const MEDIA_TYPES: ReadonlySet<ArtifactType> = new Set(['audio', 'video', 'infographic', 'slide_deck']);

// ---------------------------------------------------------------------------
// ArtifactGenerator
// ---------------------------------------------------------------------------

export class ArtifactGenerator {
  private rpc: RPCClient;

  constructor(rpcClient: RPCClient) {
    this.rpc = rpcClient;
  }

  /** Kicks off generation. Response: [[artifactId, title, typeCode, sources, statusCode, ...]]. */
  async create(config: ArtifactConfig): Promise<ArtifactResult> {
    const builder = PARAM_BUILDERS[config.type];
    if (!builder) throw new Error(`Unknown artifact type: ${config.type}`);

    const response = await this.rpc.execute(RPC.CREATE_ARTIFACT, builder(config), `/notebook/${config.notebookId}`);
    const row = Array.isArray(response) ? parseArtifactRow(response[0]) : null;
    if (!row) {
      throw new Error(
        'CREATE_ARTIFACT did not return an artifact ID. The notebook may have no ready sources, ' +
          'or this artifact type may be unavailable for the account.',
      );
    }
    return { id: row.id, type: config.type, status: resolveStatus(row.status), title: row.title || undefined };
  }

  /** Lists studio artifacts (excluding suggested ones). */
  async list(notebookId: string): Promise<ArtifactRow[]> {
    const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
    const response = await this.rpc.execute(RPC.LIST_ARTIFACTS, params, `/notebook/${notebookId}`);
    return parseArtifactList(response);
  }

  /** Polls LIST_ARTIFACTS until the artifact is completed (with its media URL) or failed. */
  async poll(
    notebookId: string,
    artifactId: string,
    options?: { intervalMs?: number; timeoutMs?: number; onTick?: (row: ArtifactRow | null) => void; wantPdf?: boolean },
  ): Promise<ArtifactRow> {
    const intervalMs = options?.intervalMs ?? 5000;
    const timeoutMs = options?.timeoutMs ?? 1_200_000; // 20 minutes (audio/video can take 15+)
    const startTime = Date.now();
    let missing = 0;

    while (Date.now() - startTime < timeoutMs) {
      const rows = await this.list(notebookId);
      const row = rows.find((r) => r.id === artifactId) ?? null;
      options?.onTick?.(row);
      if (row) {
        missing = 0;
        const status = resolveStatus(row.status);
        if (status === 'failed') return row;
        if (status === 'completed' && (!MEDIA_TYPES.has(row.type) || this.hasMediaUrl(row, options?.wantPdf))) return row;
      } else if (++missing >= 5) {
        throw new Error(`Artifact ${artifactId} disappeared from the notebook (it may have been deleted).`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Artifact ${artifactId} timed out after ${Math.round(timeoutMs / 1000)}s — it may still be generating.`);
  }

  private hasMediaUrl(row: ArtifactRow, wantPdf = false): boolean {
    switch (row.type) {
      case 'audio':
        return Boolean(extractAudioUrl(row.raw));
      case 'video':
        return Boolean(extractVideoUrl(row.raw));
      case 'infographic':
        return Boolean(extractInfographicUrl(row.raw));
      case 'slide_deck': {
        const u = extractSlideUrls(row.raw);
        // When PDF was requested, wait for the PDF url specifically — the two
        // exports can land a poll apart, and we must never save PPTX to a .pdf path.
        return wantPdf ? Boolean(u.pdf) : Boolean(u.pdf || u.pptx);
      }
      default:
        return true;
    }
  }

  /** Writes the artifact to disk (media via authenticated HTTP, text directly). */
  async download(artifact: ArtifactResult, outputPath: string): Promise<string> {
    if (artifact.downloadUrl) {
      await this.rpc.fetchMediaWithCookies(artifact.downloadUrl, outputPath);
      return outputPath;
    }
    if (artifact.content !== undefined) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, artifact.content, 'utf8');
      return outputPath;
    }
    throw new Error(
      `Artifact ${artifact.id} has no downloadUrl or content. ` +
        'Make sure the artifact is in completed status before downloading.',
    );
  }

  /** Create → poll → resolve content/URL → (optionally) download. */
  async createAndWait(
    config: ArtifactConfig,
    outputPath?: string,
    options?: { preferPdf?: boolean; log?: (msg: string) => void },
  ): Promise<ArtifactResult> {
    const initial = await this.create(config);
    const row = await this.poll(config.notebookId, initial.id, {
      wantPdf: config.type === 'slide_deck' && options?.preferPdf === true,
      onTick: (r) => options?.log?.(`  status: ${r ? resolveStatus(r.status) : 'not listed yet'}`),
    });

    if (resolveStatus(row.status) === 'failed') {
      throw new Error(`Artifact generation failed: ${row.title || initial.id}`);
    }

    const enriched = await this.resolveContent(config.notebookId, row, config.type, options?.preferPdf);

    if (outputPath && (enriched.downloadUrl || enriched.content !== undefined)) {
      try {
        enriched.filePath = await this.download(enriched, outputPath);
      } catch (downloadErr) {
        enriched.downloadError = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      }
    }
    return enriched;
  }

  /** Resolves the download URL or textual content for a completed artifact row. */
  async resolveContent(notebookId: string, row: ArtifactRow, type: ArtifactType, preferPdf = false): Promise<ArtifactResult> {
    const result: ArtifactResult = { id: row.id, type, status: resolveStatus(row.status), title: row.title || undefined };

    switch (type) {
      case 'audio':
        result.downloadUrl = extractAudioUrl(row.raw);
        break;
      case 'video':
        result.downloadUrl = extractVideoUrl(row.raw);
        break;
      case 'slide_deck': {
        const urls = extractSlideUrls(row.raw);
        if (preferPdf) {
          // Only ever hand back the PDF url here — routing the PPTX to a .pdf
          // output path would produce a file whose bytes don't match its name.
          result.downloadUrl = urls.pdf;
          result.alternateUrl = urls.pptx;
          if (!urls.pdf && urls.pptx) {
            result.downloadError =
              'Only the PPTX export is available for this slide deck; open the URL above to download it (re-run without --format pdf to save the PPTX).';
          }
        } else {
          result.downloadUrl = urls.pptx ?? urls.pdf;
          result.alternateUrl = urls.pptx ? urls.pdf : undefined;
        }
        break;
      }
      case 'infographic':
        result.downloadUrl = extractInfographicUrl(row.raw);
        break;
      case 'report':
        result.content = extractReportContent(row.raw);
        break;
      case 'quiz':
      case 'flashcards':
        result.content = await this.fetchInteractive(notebookId, row.id, 0);
        break;
      case 'mind_map':
        result.content = await this.fetchInteractive(notebookId, row.id, 3);
        break;
      case 'data_table': {
        const table = parseDataTable(row.raw[ROW.DATA_TABLE]);
        result.content = table ? dataTableToCsv(table) : undefined;
        break;
      }
    }
    return result;
  }

  /**
   * GET_INTERACTIVE_HTML (GetArtifact) → result[0][9][leaf]:
   * leaf 0 = quiz/flashcard HTML body, leaf 3 = interactive mind-map JSON tree.
   */
  private async fetchInteractive(notebookId: string, artifactId: string, leaf: 0 | 3): Promise<string | undefined> {
    const response = await this.rpc.execute(RPC.GET_INTERACTIVE_HTML, [artifactId], `/notebook/${notebookId}`);
    const block = (response as unknown[][][])?.[0]?.[9];
    const value = Array.isArray(block) ? block[leaf] : undefined;
    return typeof value === 'string' ? value : undefined;
  }
}
