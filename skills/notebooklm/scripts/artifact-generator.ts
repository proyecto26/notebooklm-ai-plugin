import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactConfig, ArtifactResult, ArtifactType } from './types.js';
import { RPCClient } from './rpc-client.js';
import {
  RPC,
  ARTIFACT_STATUS,
  AUDIO_FORMAT,
  AUDIO_LENGTH,
  VIDEO_STYLE,
  VIDEO_FORMAT,
  QUIZ_DIFFICULTY,
  QUIZ_QUANTITY,
  SLIDE_FORMAT,
  SLIDE_LENGTH,
  INFOGRAPHIC_ORIENTATION,
  INFOGRAPHIC_DETAIL,
  REPORT_FORMAT,
} from './rpc-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps each id as [[[id]]] */
function tripleNest(ids: string[]): string[][][] {
  return ids.map((id) => [[id]]);
}

/** Wraps each id as [[id]] */
function doubleNest(ids: string[]): string[][] {
  return ids.map((id) => [id]);
}

/** Resolves the status code to a human-readable status string. */
function resolveStatus(code: number): ArtifactResult['status'] {
  switch (code) {
    case ARTIFACT_STATUS.PROCESSING:
      return 'processing';
    case ARTIFACT_STATUS.PENDING:
      return 'pending';
    case ARTIFACT_STATUS.COMPLETED:
      return 'completed';
    case ARTIFACT_STATUS.FAILED:
      return 'failed';
    default:
      return 'processing';
  }
}

/**
 * Recursively searches a nested structure for a string that starts with "http".
 * Used to extract download URLs from deeply nested artifact responses.
 */
function findUrlInNested(data: unknown): string | undefined {
  if (typeof data === 'string' && data.startsWith('http')) {
    return data;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUrlInNested(item);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Extracts the artifact ID and status from a LIST_ARTIFACTS response entry.
 * The response is a nested array; we search for the matching artifact.
 */
function parseArtifactEntry(entry: unknown[]): { id: string; status: number; title: string; data: unknown[] } | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  // entry[0] is typically the artifact ID
  const id = typeof entry[0] === 'string' ? entry[0] : null;
  if (!id) return null;

  // Status is typically at entry[4] or entry[3]
  let status = 0;
  if (typeof entry[4] === 'number') {
    status = entry[4];
  } else if (typeof entry[3] === 'number') {
    status = entry[3];
  }

  // Title is typically at entry[1] or entry[2]
  let title = '';
  if (typeof entry[1] === 'string') {
    title = entry[1];
  } else if (typeof entry[2] === 'string') {
    title = entry[2];
  }

  return { id, status, title, data: entry };
}

// ---------------------------------------------------------------------------
// Param builders
// ---------------------------------------------------------------------------

function buildAudioParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const formatCode = AUDIO_FORMAT[config.audioFormat ?? 'deep_dive'];
  const lengthCode = AUDIO_LENGTH[config.audioLength ?? 'default'];
  const instructions = config.instructions ?? '';
  const language = config.language ?? 'en';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      1,
      tripleNest(sourceIds),
      null,
      null,
      [null, [instructions, lengthCode, null, doubleNest(sourceIds), language, null, formatCode]],
    ],
  ];
}

function buildVideoParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const styleCode = VIDEO_STYLE[config.videoStyle ?? 'auto'];
  const formatCode = VIDEO_FORMAT[config.videoFormat ?? 'explainer'];
  const instructions = config.instructions ?? '';
  const language = config.language ?? 'en';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      3,
      tripleNest(sourceIds),
      null,
      null,
      null,
      null,
      [null, null, [doubleNest(sourceIds), language, instructions, null, formatCode, styleCode]],
    ],
  ];
}

function buildReportParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const formatCode = REPORT_FORMAT[config.reportFormat ?? 'briefing'];
  const instructions = config.instructions ?? '';
  const language = config.language ?? 'en';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      2,
      tripleNest(sourceIds),
      null,
      null,
      null,
      [null, [null, null, null, doubleNest(sourceIds), language, instructions, formatCode, true]],
    ],
  ];
}

function buildQuizParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const difficultyCode = QUIZ_DIFFICULTY[config.difficulty ?? 'medium'];
  const quantityCode = QUIZ_QUANTITY[config.quantity ?? 'standard'];
  const instructions = config.instructions ?? '';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      4,
      tripleNest(sourceIds),
      null,
      null,
      null,
      null,
      null,
      [null, [2, null, instructions, null, null, null, null, [difficultyCode, quantityCode]]],
    ],
  ];
}

function buildFlashcardsParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const difficultyCode = QUIZ_DIFFICULTY[config.difficulty ?? 'medium'];
  const quantityCode = QUIZ_QUANTITY[config.quantity ?? 'standard'];
  const instructions = config.instructions ?? '';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      4,
      tripleNest(sourceIds),
      null,
      null,
      null,
      null,
      null,
      [null, [1, null, instructions, null, null, null, [difficultyCode, quantityCode]]],
    ],
  ];
}

function buildSlideDeckParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const formatCode = SLIDE_FORMAT[config.slideDeckFormat ?? 'detailed'];
  const lengthCode = SLIDE_LENGTH[config.slideDeckLength ?? 'default'];
  const instructions = config.instructions ?? '';
  const language = config.language ?? 'en';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      8,
      tripleNest(sourceIds),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [[instructions, language, formatCode, lengthCode]],
    ],
  ];
}

function buildInfographicParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const orientationCode = INFOGRAPHIC_ORIENTATION[config.infographicOrientation ?? 'landscape'];
  const detailCode = INFOGRAPHIC_DETAIL[config.infographicDetail ?? 'standard'];
  const instructions = config.instructions ?? '';
  const language = config.language ?? 'en';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      7,
      tripleNest(sourceIds),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [[instructions, language, null, orientationCode, detailCode]],
    ],
  ];
}

function buildDataTableParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];
  const instructions = config.instructions ?? '';
  const language = config.language ?? 'en';

  return [
    [2],
    config.notebookId,
    [
      null,
      null,
      9,
      tripleNest(sourceIds),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [[instructions, language]],
    ],
  ];
}

function buildMindMapParams(config: ArtifactConfig): unknown[] {
  const sourceIds = config.sourceIds ?? [];

  return [
    tripleNest(sourceIds),
    null,
    null,
    null,
    null,
    ['interactive_mindmap', [['[CONTEXT]', '']], ''],
    null,
    [2, null, [1]],
  ];
}

// ---------------------------------------------------------------------------
// ArtifactGenerator
// ---------------------------------------------------------------------------

export class ArtifactGenerator {
  private rpc: RPCClient;

  constructor(rpcClient: RPCClient) {
    this.rpc = rpcClient;
  }

  /**
   * Creates an artifact by dispatching to the appropriate RPC based on type.
   * Returns the initial artifact result (usually in processing/pending state).
   */
  async create(config: ArtifactConfig): Promise<ArtifactResult> {
    if (config.type === 'mind_map') {
      return this.createMindMap(config);
    }

    const paramBuilders: Record<string, (c: ArtifactConfig) => unknown[]> = {
      audio: buildAudioParams,
      video: buildVideoParams,
      report: buildReportParams,
      quiz: buildQuizParams,
      flashcards: buildFlashcardsParams,
      slide_deck: buildSlideDeckParams,
      infographic: buildInfographicParams,
      data_table: buildDataTableParams,
    };

    const builder = paramBuilders[config.type];
    if (!builder) {
      throw new Error(`Unknown artifact type: ${config.type}`);
    }

    const params = builder(config);
    const sourcePath = `/notebook/${config.notebookId}`;
    const response = await this.rpc.execute(RPC.CREATE_ARTIFACT, params, sourcePath);

    // The response typically contains the artifact ID
    const data = response as unknown[];
    let artifactId = '';
    if (Array.isArray(data)) {
      artifactId = this.extractArtifactId(data);
    }

    return {
      id: artifactId,
      type: config.type,
      status: 'processing',
    };
  }

  /**
   * Creates a mind map using the dedicated GENERATE_MIND_MAP RPC.
   */
  private async createMindMap(config: ArtifactConfig): Promise<ArtifactResult> {
    const params = buildMindMapParams(config);
    const sourcePath = `/notebook/${config.notebookId}`;
    const response = await this.rpc.execute(RPC.GENERATE_MIND_MAP, params, sourcePath);

    const data = response as unknown[];
    let artifactId = '';
    if (Array.isArray(data)) {
      artifactId = this.extractArtifactId(data);
    }

    return {
      id: artifactId,
      type: 'mind_map',
      status: 'processing',
    };
  }

  /**
   * Polls the LIST_ARTIFACTS RPC until the artifact reaches COMPLETED or FAILED.
   */
  async poll(
    notebookId: string,
    artifactId: string,
    options?: { intervalMs?: number; timeoutMs?: number },
  ): Promise<ArtifactResult> {
    const intervalMs = options?.intervalMs ?? 5000;
    const timeoutMs = options?.timeoutMs ?? 1_200_000; // 20 minutes (audio/video can take 15+)
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const params = [
        [2],
        notebookId,
        'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"',
      ];
      const sourcePath = `/notebook/${notebookId}`;
      const response = await this.rpc.execute(RPC.LIST_ARTIFACTS, params, sourcePath);

      const data = response as unknown[];
      if (Array.isArray(data)) {
        const artifact = this.findArtifactInList(data, artifactId);
        if (artifact) {
          const status = resolveStatus(artifact.status);
          if (status === 'completed' || status === 'failed') {
            return {
              id: artifactId,
              type: this.inferTypeFromData(artifact.data),
              status,
              title: artifact.title,
            };
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Artifact ${artifactId} timed out after ${timeoutMs}ms`);
  }

  /**
   * Downloads an artifact to a local file path.
   *
   * For text-based artifacts (report, quiz, flashcards), writes the content
   * directly. For media artifacts (audio, video, slides, infographic),
   * downloads via authenticated HTTP.
   */
  async download(artifact: ArtifactResult, outputPath: string): Promise<string> {
    // First, get the full artifact data from LIST_ARTIFACTS if we need URLs
    if (artifact.downloadUrl) {
      await this.rpc.fetchMediaWithCookies(artifact.downloadUrl, outputPath);
      return outputPath;
    }

    if (artifact.content) {
      const { mkdir: mkdirFs } = await import('node:fs/promises');
      await mkdirFs(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, artifact.content, 'utf8');
      return outputPath;
    }

    throw new Error(
      `Artifact ${artifact.id} has no downloadUrl or content. ` +
        'Make sure the artifact is in completed status before downloading.',
    );
  }

  /**
   * Creates an artifact, polls until completion, and optionally downloads it.
   * This is the main high-level method for end-to-end artifact generation.
   */
  async createAndWait(config: ArtifactConfig, outputPath?: string): Promise<ArtifactResult> {
    const initial = await this.create(config);

    if (!initial.id) {
      throw new Error('CREATE_ARTIFACT did not return an artifact ID');
    }

    // Poll until done
    const completed = await this.poll(config.notebookId, initial.id);

    if (completed.status === 'failed') {
      throw new Error(`Artifact generation failed: ${completed.title ?? initial.id}`);
    }

    // Fetch full artifact details to get download URLs/content
    const enriched = await this.enrichArtifact(config.notebookId, initial.id, config.type);

    // Download if output path is specified
    if (outputPath && (enriched.downloadUrl || enriched.content)) {
      try {
        enriched.filePath = await this.download(enriched, outputPath);
      } catch (downloadErr) {
        // Download failed but artifact was created — return result with URL
        // so the user can open it in their browser
        enriched.status = 'completed';
        enriched.downloadError = downloadErr instanceof Error ? downloadErr.message : String(downloadErr);
      }
    }

    return enriched;
  }

  /**
   * Enriches an artifact with download URLs and content by re-fetching
   * LIST_ARTIFACTS and extracting the relevant data.
   */
  private async enrichArtifact(
    notebookId: string,
    artifactId: string,
    type: ArtifactType,
  ): Promise<ArtifactResult> {
    const params = [
      [2],
      notebookId,
      'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"',
    ];
    const sourcePath = `/notebook/${notebookId}`;
    const response = await this.rpc.execute(RPC.LIST_ARTIFACTS, params, sourcePath);

    const data = response as unknown[];
    const artifact = Array.isArray(data) ? this.findArtifactInList(data, artifactId) : null;

    if (!artifact) {
      return { id: artifactId, type, status: 'completed' };
    }

    const result: ArtifactResult = {
      id: artifactId,
      type,
      status: resolveStatus(artifact.status),
      title: artifact.title,
    };

    // Extract download URL or content based on type
    switch (type) {
      case 'audio':
        result.downloadUrl = this.extractAudioUrl(artifact.data);
        break;
      case 'video':
        result.downloadUrl = this.extractVideoUrl(artifact.data);
        break;
      case 'slide_deck':
        result.downloadUrl = this.extractSlideUrl(artifact.data);
        break;
      case 'infographic':
        result.downloadUrl = this.extractInfographicUrl(artifact.data);
        break;
      case 'report':
        result.content = this.extractReportContent(artifact.data);
        break;
      case 'quiz':
      case 'flashcards':
        result.content = await this.fetchInteractiveHtml(notebookId, artifactId);
        break;
      case 'mind_map':
        result.content = await this.fetchInteractiveHtml(notebookId, artifactId);
        break;
      case 'data_table':
        result.content = this.extractDataTableContent(artifact.data);
        break;
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // URL / content extractors
  // -----------------------------------------------------------------------

  /** Audio: find entry in data[6][5] with "audio/mp4" mime type */
  private extractAudioUrl(data: unknown[]): string | undefined {
    try {
      const audioSection = (data as unknown[][])?.[6];
      if (Array.isArray(audioSection)) {
        const mediaEntries = audioSection[5];
        if (Array.isArray(mediaEntries)) {
          for (const entry of mediaEntries) {
            if (Array.isArray(entry)) {
              // Look for audio/mp4 mime type and extract URL
              const url = findUrlInNested(entry);
              if (url) return url;
            }
          }
        }
        // Fallback: scan the entire audio section for URLs
        return findUrlInNested(audioSection);
      }
    } catch {
      // Fallback to generic URL search
    }
    return findUrlInNested(data);
  }

  /** Video: find entry in data[8] with "video/mp4" mime type */
  private extractVideoUrl(data: unknown[]): string | undefined {
    try {
      const videoSection = (data as unknown[][])?.[8];
      if (Array.isArray(videoSection)) {
        return findUrlInNested(videoSection);
      }
    } catch {
      // Fallback to generic URL search
    }
    return findUrlInNested(data);
  }

  /** Slides: data[16][3] = PDF URL, data[16][4] = PPTX URL */
  private extractSlideUrl(data: unknown[]): string | undefined {
    try {
      const slideSection = (data as unknown[][])?.[16];
      if (Array.isArray(slideSection)) {
        // Prefer PPTX, then PDF
        if (typeof slideSection[4] === 'string' && slideSection[4].startsWith('http')) {
          return slideSection[4];
        }
        if (typeof slideSection[3] === 'string' && slideSection[3].startsWith('http')) {
          return slideSection[3];
        }
        return findUrlInNested(slideSection);
      }
    } catch {
      // Fallback
    }
    return findUrlInNested(data);
  }

  /** Infographic: scan nested arrays for URL starting with "http" */
  private extractInfographicUrl(data: unknown[]): string | undefined {
    return findUrlInNested(data);
  }

  /** Report: data[7][0] or data[7] as markdown string */
  private extractReportContent(data: unknown[]): string | undefined {
    try {
      const reportSection = data?.[7];
      if (typeof reportSection === 'string') {
        return reportSection;
      }
      if (Array.isArray(reportSection)) {
        if (typeof reportSection[0] === 'string') {
          return reportSection[0];
        }
        // Try to find the largest string in the section (likely the content)
        let longest = '';
        for (const item of reportSection) {
          if (typeof item === 'string' && item.length > longest.length) {
            longest = item;
          }
        }
        if (longest) return longest;
      }
    } catch {
      // Fallback
    }
    return undefined;
  }

  /** Data table: extract structured data as JSON string */
  private extractDataTableContent(data: unknown[]): string | undefined {
    try {
      // Data tables are typically returned as structured arrays
      // Serialize the relevant portion as JSON for saving
      return JSON.stringify(data, null, 2);
    } catch {
      return undefined;
    }
  }

  /** Fetches interactive HTML content for quiz, flashcards, and mind maps */
  private async fetchInteractiveHtml(notebookId: string, artifactId: string): Promise<string | undefined> {
    try {
      const params = [[2], notebookId, artifactId];
      const sourcePath = `/notebook/${notebookId}`;
      const response = await this.rpc.execute(RPC.GET_INTERACTIVE_HTML, params, sourcePath);

      if (typeof response === 'string') return response;
      if (Array.isArray(response)) {
        // The HTML content is usually a string in the response array
        for (const item of response) {
          if (typeof item === 'string' && item.length > 100) {
            return item;
          }
        }
        // Fallback: return the whole thing as JSON
        return JSON.stringify(response, null, 2);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Extracts the artifact ID from a CREATE_ARTIFACT response.
   * Walks the response array looking for the first string that looks like an ID.
   */
  private extractArtifactId(data: unknown[]): string {
    // CREATE_ARTIFACT response: [["artifactId", "title", typeCode, [sources], statusCode, ...]]
    // The artifact ID is at data[0][0] (first element of the inner array)
    if (Array.isArray(data[0]) && typeof data[0][0] === 'string' && data[0][0].length > 5) {
      return data[0][0];
    }
    // Fallback: data[0] is the ID directly
    if (typeof data[0] === 'string' && data[0].length > 5) {
      return data[0];
    }
    // Search nested arrays for a UUID-style string
    const id = this.findIdInNested(data);
    return id ?? '';
  }

  /** Recursively searches for a Google-style ID (long alphanumeric/base64 string). */
  private findIdInNested(data: unknown, depth = 0): string | undefined {
    if (depth > 5) return undefined;
    if (typeof data === 'string' && data.length >= 8 && /^[a-zA-Z0-9_-]+$/.test(data)) {
      return data;
    }
    if (Array.isArray(data)) {
      for (const item of data) {
        const found = this.findIdInNested(item, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Finds a specific artifact by ID in a LIST_ARTIFACTS response.
   * The response is typically a nested array of artifact entries.
   */
  private findArtifactInList(
    data: unknown[],
    artifactId: string,
  ): { id: string; status: number; title: string; data: unknown[] } | null {
    // The list response structure varies, but artifacts are typically
    // nested arrays where each entry starts with the artifact ID.
    const candidates = this.flattenArtifactEntries(data);
    for (const entry of candidates) {
      const parsed = parseArtifactEntry(entry);
      if (parsed && parsed.id === artifactId) {
        return parsed;
      }
    }
    return null;
  }

  /**
   * Attempts to extract individual artifact entries from a LIST_ARTIFACTS response.
   * The response may be nested at various depths.
   */
  private flattenArtifactEntries(data: unknown[]): unknown[][] {
    const entries: unknown[][] = [];

    // If the top level looks like a list of artifact entries
    for (const item of data) {
      if (Array.isArray(item)) {
        // Check if this looks like an artifact entry (starts with a string ID)
        if (typeof item[0] === 'string' && item[0].length >= 8) {
          entries.push(item);
        } else {
          // Recurse one level
          for (const sub of item) {
            if (Array.isArray(sub) && typeof sub[0] === 'string' && sub[0].length >= 8) {
              entries.push(sub);
            }
          }
        }
      }
    }

    return entries;
  }

  /** Infers the artifact type from the response data based on type code. */
  private inferTypeFromData(data: unknown[]): ArtifactType {
    // Try to find the type code in the data array
    // The type code is usually at a consistent position
    for (const item of data) {
      if (typeof item === 'number') {
        switch (item) {
          case 1:
            return 'audio';
          case 2:
            return 'report';
          case 3:
            return 'video';
          case 4:
            return 'quiz'; // or flashcards
          case 7:
            return 'infographic';
          case 8:
            return 'slide_deck';
          case 9:
            return 'data_table';
        }
      }
    }
    return 'report'; // fallback
  }
}
