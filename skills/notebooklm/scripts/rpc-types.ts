// RPC method IDs and wire enums for NotebookLM's batchexecute API.
//
// Source of truth: notebooklm-py (teng-lin/notebooklm-py, verified live Aug 2026),
// cross-checked against notebooklm-sdk (agmmnn). Google can rotate these IDs at
// any time; when a call starts failing with "Method ID may have changed", diff
// against those projects first.
export const RPC = {
  LIST_NOTEBOOKS: 'wXbhsf',
  CREATE_NOTEBOOK: 'CCqFvf',
  GET_NOTEBOOK: 'rLM1Ne',
  RENAME_NOTEBOOK: 's0tc2d',
  DELETE_NOTEBOOK: 'WWINqb',
  ADD_SOURCE: 'izAoDd',
  ADD_SOURCE_FILE: 'o4cbdc',
  DELETE_SOURCE: 'tGMBJ',
  GET_SOURCE: 'hizoJc',
  UPDATE_SOURCE: 'b7Wfje',
  CREATE_ARTIFACT: 'R7cb6c',
  LIST_ARTIFACTS: 'gArtLc',
  DELETE_ARTIFACT: 'V5N4be',
  RENAME_ARTIFACT: 'rc3d8d',
  EXPORT_ARTIFACT: 'Krh3pd',
  SHARE_ARTIFACT: 'RGP97b',
  GET_INTERACTIVE_HTML: 'v9rmvd',
  GENERATE_MIND_MAP: 'yyryJe',
  CREATE_NOTE: 'CYK0Xb',
  GET_NOTES_AND_MIND_MAPS: 'cFji9',
  UPDATE_NOTE: 'cYAfTb',
  DELETE_NOTE: 'AH0mwd',
  SHARE_NOTEBOOK: 'QDyure',
  GET_SHARE_STATUS: 'JFMDGd',
  REFRESH_SOURCE: 'FLmJqe',
  START_FAST_RESEARCH: 'Ljjv0c',
  START_DEEP_RESEARCH: 'QA9ei',
  POLL_RESEARCH: 'e3bVqc',
  IMPORT_RESEARCH: 'LBwxtb',
  GET_LAST_CONVERSATION_ID: 'hPTbtc',
  GET_CONVERSATION_TURNS: 'khqZz',
} as const;

// ---------------------------------------------------------------------------
// Request wrapper blocks
// ---------------------------------------------------------------------------

/**
 * Request-options wrapper `[2, null, null, [1, ...9 nulls, [1]]]`.
 *
 * Since Google's mid-2026 backend migration, CREATE_NOTEBOOK / GET_NOTEBOOK /
 * ADD_SOURCE / ADD_SOURCE_FILE reject the older bare `[2]` tail with
 * status 3/5/9. Returns a fresh array each call so callers never share a
 * mutable nested structure.
 */
export function templateBlock(): unknown[] {
  return [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]];
}

/**
 * Client-capability envelope sent as param 0 of CREATE_ARTIFACT. The web
 * client sends the full envelope (older captures used the shorter `[2]`).
 */
export function artifactClientOptions(): unknown[] {
  return [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]], [[1, 4, 8, 2, 3, 6]]];
}

// ---------------------------------------------------------------------------
// Artifact codes
// ---------------------------------------------------------------------------

/** Artifact type codes at descriptor index [2] of CREATE_ARTIFACT and row[2] of LIST_ARTIFACTS. */
export const ARTIFACT_TYPE_CODE = {
  audio: 1,
  report: 2,
  video: 3,
  /** Shared by quiz, flashcards and the interactive mind map — see APP_VARIANT. */
  quiz: 4,
  flashcards: 4,
  mind_map: 4,
  infographic: 7,
  slide_deck: 8,
  data_table: 9,
} as const;

/** Sub-variant at row[9][1][0] for type-code-4 artifacts. */
export const APP_VARIANT = { flashcards: 1, quiz: 2, mind_map: 4 } as const;

/** Artifact status codes at row[4] of LIST_ARTIFACTS. */
export const ARTIFACT_STATUS = {
  UNKNOWN: 0,
  PENDING: 1,
  PROCESSING: 2,
  COMPLETED: 3,
  FAILED: 4,
  SUGGESTED: 5,
  PENDING_REVIEW: 6,
} as const;

export const AUDIO_FORMAT = { deep_dive: 1, brief: 2, critique: 3, debate: 4 } as const;
export const AUDIO_LENGTH = { short: 1, default: 2, long: 3 } as const;

export const VIDEO_STYLE = {
  custom: 0,
  auto: 1,
  classic: 2,
  whiteboard: 3,
  heritage: 4,
  paper_craft: 5,
  watercolor: 6,
  anime: 7,
  retro_print: 8,
  kawaii: 9,
} as const;
export const VIDEO_FORMAT = { explainer: 1, brief: 2, cinematic: 3, short: 4 } as const;

export const QUIZ_DIFFICULTY = { easy: 1, medium: 2, hard: 3 } as const;
export const QUIZ_QUANTITY = { fewer: 1, standard: 2, more: 3 } as const;

export const SLIDE_FORMAT = { detailed: 1, presenter: 2 } as const;
export const SLIDE_LENGTH = { default: 1, short: 2 } as const;

export const INFOGRAPHIC_ORIENTATION = { landscape: 1, portrait: 2, square: 3 } as const;
export const INFOGRAPHIC_DETAIL = { concise: 1, standard: 2, detailed: 3 } as const;
export const INFOGRAPHIC_STYLE = {
  auto: 1,
  sketch_note: 2,
  professional: 3,
  bento_grid: 4,
  editorial: 5,
  instructional: 6,
  bricks: 7,
  clay: 8,
  anime: 9,
  kawaii: 10,
  scientific: 11,
} as const;

/**
 * Report presets. The backend takes a free-text prompt plus a title/description
 * (not a numeric format code) — these mirror the Studio UI's built-in formats.
 */
export const REPORT_PRESETS = {
  briefing: {
    title: 'Briefing Doc',
    description: 'Key insights and important quotes',
    prompt:
      'Create a comprehensive briefing document that includes an Executive Summary, ' +
      'detailed analysis of key themes, important quotes with context, and actionable insights.',
  },
  study_guide: {
    title: 'Study Guide',
    description: 'Short-answer quiz, essay questions, glossary',
    prompt:
      'Create a comprehensive study guide that includes key concepts, short-answer practice ' +
      'questions, essay prompts for deeper exploration, and a glossary of important terms.',
  },
  blog_post: {
    title: 'Blog Post',
    description: 'Insightful takeaways in readable article format',
    prompt:
      'Write an engaging blog post that presents the key insights in an accessible, ' +
      'reader-friendly format with an attention-grabbing introduction and compelling conclusion.',
  },
  custom: {
    title: 'Custom Report',
    description: 'Custom format',
    prompt: 'Create a report based on the provided sources.',
  },
} as const;

/** Source ingestion status at source row[3][1]. */
export const SOURCE_STATUS = { PROCESSING: 1, READY: 2, ERROR: 3, PREPARING: 5 } as const;

/** Source type codes at source row[2][4]. */
export const SOURCE_TYPE_CODE: Record<number, string> = {
  0: 'unknown',
  1: 'google_docs',
  2: 'google_slides',
  3: 'pdf',
  4: 'pasted_text',
  5: 'web',
  6: 'powerpoint',
  8: 'markdown',
  9: 'youtube',
  10: 'media',
  11: 'docx',
  13: 'image',
  14: 'google_spreadsheet',
  16: 'csv',
  17: 'epub',
};

/** Research task status at task_info[4]: 1 in progress, 2 completed, 6 completed (deep). */
export const RESEARCH_STATUS = { IN_PROGRESS: 1, COMPLETED: 2, COMPLETED_DEEP: 6 } as const;
export const RESEARCH_SOURCE_TYPE = { web: 1, drive: 2 } as const;
