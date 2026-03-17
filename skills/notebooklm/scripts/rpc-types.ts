// RPC Method IDs (from notebooklm-py and notebooklm-sdk)
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
} as const;

// Artifact type codes sent in CREATE_ARTIFACT RPC
export const ARTIFACT_TYPE_CODE: Record<string, number> = {
  audio: 1,
  report: 2,
  video: 3,
  quiz: 4,
  flashcards: 4, // same code, different config
  mind_map: 0, // uses separate RPC
  infographic: 7,
  slide_deck: 8,
  data_table: 9,
};

// Artifact status codes
export const ARTIFACT_STATUS = {
  PROCESSING: 1,
  PENDING: 2,
  COMPLETED: 3,
  FAILED: 4,
} as const;

// Audio format codes
export const AUDIO_FORMAT = { deep_dive: 1, brief: 2, critique: 3, debate: 4 } as const;
export const AUDIO_LENGTH = { short: 1, default: 2, long: 3 } as const;

// Video style codes
export const VIDEO_STYLE = {
  auto: 1,
  custom: 2,
  classic: 3,
  whiteboard: 4,
  kawaii: 5,
  anime: 6,
  watercolor: 7,
  retro_print: 8,
  heritage: 9,
  paper_craft: 10,
} as const;
export const VIDEO_FORMAT = { explainer: 1, brief: 2 } as const;

// Quiz/Flashcard codes
export const QUIZ_DIFFICULTY = { easy: 1, medium: 2, hard: 3 } as const;
export const QUIZ_QUANTITY = { fewer: 1, standard: 2, more: 3 } as const;

// Slide deck codes
export const SLIDE_FORMAT = { detailed: 1, presenter: 2 } as const;
export const SLIDE_LENGTH = { default: 1, short: 2 } as const;

// Infographic codes
export const INFOGRAPHIC_ORIENTATION = { landscape: 1, portrait: 2, square: 3 } as const;
export const INFOGRAPHIC_DETAIL = { concise: 1, standard: 2, detailed: 3 } as const;

// Report format codes
export const REPORT_FORMAT = { briefing: 1, study_guide: 2, blog_post: 3, custom: 4 } as const;
