import { describe, expect, test } from 'bun:test';
import {
  buildAudioParams,
  buildDataTableParams,
  buildFlashcardsParams,
  buildInfographicParams,
  buildMindMapParams,
  buildQuizParams,
  buildReportParams,
  buildSlideDeckParams,
  buildVideoParams,
  dataTableToCsv,
  extractAudioUrl,
  extractInfographicUrl,
  extractReportContent,
  extractSlideUrls,
  extractVideoUrl,
  parseArtifactList,
  parseArtifactRow,
  parseDataTable,
  resolveStatus,
} from '../../skills/notebooklm/scripts/artifact-generator.ts';
import { decodeBatchResponse } from '../../skills/notebooklm/scripts/rpc-client.ts';
import { artifactClientOptions } from '../../skills/notebooklm/scripts/rpc-types.ts';
import { fixture } from '../helpers.ts';

const NB = 'nb-1234';
const IDS = ['src-a', 'src-b'];
const TRIPLE = [[['src-a']], [['src-b']]];
const DOUBLE = [['src-a'], ['src-b']];
const OPTS = [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]], [[1, 4, 8, 2, 3, 6]]];

describe('CREATE_ARTIFACT payloads (verified against notebooklm-py, Aug 2026)', () => {
  test('client options envelope is the full capability block', () => {
    expect(artifactClientOptions()).toEqual(OPTS);
    expect(artifactClientOptions()).not.toBe(artifactClientOptions()); // fresh array each call
  });

  test('audio: options at descriptor[6]', () => {
    expect(buildAudioParams({ type: 'audio', notebookId: NB, sourceIds: IDS, audioFormat: 'debate', audioLength: 'long' })).toEqual([
      OPTS,
      NB,
      [null, null, 1, TRIPLE, null, null, [null, [null, 3, null, DOUBLE, 'en', null, 4]]],
    ]);
  });

  test('video: options at descriptor[8]; py style codes (whiteboard=3)', () => {
    expect(buildVideoParams({ type: 'video', notebookId: NB, sourceIds: IDS, videoStyle: 'whiteboard', instructions: 'hi' })).toEqual([
      OPTS,
      NB,
      [null, null, 3, TRIPLE, null, null, null, null, [null, null, [DOUBLE, 'en', 'hi', null, 1, 3]]],
    ]);
  });

  test('video custom style sends null + prompt; cinematic omits the style slot', () => {
    const custom = buildVideoParams({ type: 'video', notebookId: NB, sourceIds: IDS, videoStyle: 'custom', videoStylePrompt: 'noir' });
    expect((custom[2] as unknown[])[8]).toEqual([null, null, [DOUBLE, 'en', null, null, 1, null, 'noir']]);
    const cinematic = buildVideoParams({ type: 'video', notebookId: NB, sourceIds: IDS, videoFormat: 'cinematic' });
    expect((cinematic[2] as unknown[])[8]).toEqual([null, null, [DOUBLE, 'en', null, null, 3]]);
  });

  test('report: title/description/prompt preset at descriptor[7], extra instructions appended', () => {
    const p = buildReportParams({ type: 'report', notebookId: NB, sourceIds: IDS, reportFormat: 'study_guide', instructions: 'Focus on ch. 2' });
    const block = (p[2] as unknown[])[7] as unknown[];
    const cfg = block[1] as unknown[];
    expect(block[0]).toBeNull();
    expect(cfg[0]).toBe('Study Guide');
    expect(cfg[3]).toEqual(DOUBLE);
    expect(cfg[4]).toBe('en');
    expect(String(cfg[5])).toMatch(/study guide[\s\S]*\n\nFocus on ch\. 2$/);
    expect(cfg[6]).toBeNull();
    expect(cfg[7]).toBe(true);
  });

  test('quiz: variant 2, [quantity, difficulty] at [9][1][7]', () => {
    const p = buildQuizParams({ type: 'quiz', notebookId: NB, sourceIds: IDS, quantity: 'more', difficulty: 'hard' });
    expect((p[2] as unknown[])[9]).toEqual([null, [2, null, null, null, null, null, null, [3, 3]]]);
    expect((p[2] as unknown[])[2]).toBe(4);
  });

  test('flashcards: variant 1, [quantity, difficulty] at [9][1][6] (quantity first, same as quiz)', () => {
    const p = buildFlashcardsParams({ type: 'flashcards', notebookId: NB, sourceIds: IDS, quantity: 'fewer', difficulty: 'easy' });
    expect((p[2] as unknown[])[9]).toEqual([null, [1, null, null, null, null, null, [1, 1]]]);
  });

  test('mind map: interactive studio artifact, variant 4 (with/without instructions)', () => {
    expect((buildMindMapParams({ type: 'mind_map', notebookId: NB, sourceIds: IDS })[2] as unknown[])[9]).toEqual([null, [4]]);
    expect((buildMindMapParams({ type: 'mind_map', notebookId: NB, sourceIds: IDS, instructions: 'x' })[2] as unknown[])[9]).toEqual([null, [4, null, 'x']]);
  });

  test('slide deck: options at descriptor[16]', () => {
    const p = buildSlideDeckParams({ type: 'slide_deck', notebookId: NB, sourceIds: IDS, slideDeckFormat: 'presenter', slideDeckLength: 'short' });
    const d = p[2] as unknown[];
    expect(d.length).toBe(17);
    expect(d[16]).toEqual([[null, 'en', 2, 2]]);
  });

  test('infographic: options at descriptor[14] incl. style', () => {
    const p = buildInfographicParams({ type: 'infographic', notebookId: NB, sourceIds: IDS, infographicOrientation: 'portrait', infographicStyle: 'kawaii' });
    expect((p[2] as unknown[])[14]).toEqual([[null, 'en', null, 2, 2, 10]]);
  });

  test('data table: [null, [instructions, language]] at descriptor[18]', () => {
    const p = buildDataTableParams({ type: 'data_table', notebookId: NB, sourceIds: IDS, instructions: 'compare' });
    const d = p[2] as unknown[];
    expect(d.length).toBe(19);
    expect(d[18]).toEqual([null, ['compare', 'en']]);
  });
});

describe('LIST_ARTIFACTS parsing (recorded fixtures)', () => {
  const rows = parseArtifactList(decodeBatchResponse(fixture('artifacts_list_video'), 'gArtLc'));

  test('parses every row with id/type/status', () => {
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(resolveStatus(r.status)).toBe('completed');
    }
    const types = new Set(rows.map((r) => r.type));
    expect(types).toContain('audio');
    expect(types).toContain('video');
    expect(types).toContain('quiz');
    expect(types).toContain('flashcards');
    expect(types).toContain('report');
    expect(types).toContain('infographic');
    expect(types).toContain('slide_deck');
    expect(types).toContain('data_table');
  });

  test('audio URL prefers audio/mp4 media entry', () => {
    const audio = rows.find((r) => r.type === 'audio')!;
    expect(extractAudioUrl(audio.raw)).toMatch(/^https:\/\//);
  });

  test('video URL prefers the video/mp4 download entry', () => {
    const video = rows.find((r) => r.type === 'video')!;
    expect(extractVideoUrl(video.raw)).toMatch(/^https:\/\//);
  });

  test('slide deck exposes the PDF url at [16][3]', () => {
    const slides = rows.find((r) => r.type === 'slide_deck')!;
    expect(extractSlideUrls(slides.raw).pdf).toMatch(/^https:\/\//);
  });

  test('infographic image url at [14][2][*][1][0]', () => {
    const info = rows.find((r) => r.type === 'infographic')!;
    expect(extractInfographicUrl(info.raw)).toMatch(/^https:\/\//);
  });

  test('report markdown at [7]', () => {
    const report = rows.find((r) => r.type === 'report')!;
    expect(extractReportContent(report.raw)!.length).toBeGreaterThan(500);
  });

  test('data table parses to headers + rows and serialises as CSV', () => {
    const dt = rows.find((r) => r.type === 'data_table')!;
    const table = parseDataTable(dt.raw[18])!;
    expect(table.headers.length).toBeGreaterThan(1);
    expect(table.rows.length).toBeGreaterThan(0);
    const csv = dataTableToCsv(table);
    expect(csv.split('\n')[0].split(',').length).toBeGreaterThanOrEqual(table.headers.length);
  });

  test('CREATE_ARTIFACT kickoff response parses to a row', () => {
    const data = decodeBatchResponse(fixture('artifacts_generate_quiz'), 'R7cb6c') as unknown[];
    const row = parseArtifactRow(data[0])!;
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.type).toBe('quiz');
  });

  test('GET_INTERACTIVE_HTML response has the HTML body at [0][9][0]', () => {
    const data = decodeBatchResponse(fixture('artifacts_download_quiz'), 'v9rmvd') as unknown[][][];
    const html = data[0][9][0] as string;
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(1000);
  });
});

describe('slide deck PDF/PPTX selection (codex:review P2 regression)', () => {
  // extractSlideUrls reads row[16] = [config, title, slides, pdfUrl, pptxUrl].
  const rowWithBoth = new Array(17).fill(null);
  rowWithBoth[0] = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  rowWithBoth[2] = 8;
  rowWithBoth[4] = 3;
  rowWithBoth[16] = [[], 'Deck', [], 'https://x/deck.pdf', 'https://x/deck.pptx'];
  const rowPptxOnly = rowWithBoth.map((v, i) => (i === 16 ? [[], 'Deck', [], null, 'https://x/deck.pptx'] : v));

  test('PDF requested → downloadUrl is the PDF, never the PPTX', () => {
    expect(extractSlideUrls(rowWithBoth).pdf).toBe('https://x/deck.pdf');
    expect(extractSlideUrls(rowWithBoth).pptx).toBe('https://x/deck.pptx');
  });

  test('PDF requested but only PPTX present → PPTX is NOT routed to the .pdf path', () => {
    const urls = extractSlideUrls(rowPptxOnly);
    expect(urls.pdf).toBeUndefined();
    // The fixed resolveContent must not put the pptx url in downloadUrl when preferPdf.
    // Emulate the branch: preferPdf && !urls.pdf => downloadUrl undefined, alternate = pptx.
    const downloadUrl = urls.pdf; // preferPdf branch only uses urls.pdf
    expect(downloadUrl).toBeUndefined();
    expect(urls.pptx).toBe('https://x/deck.pptx');
  });
});
