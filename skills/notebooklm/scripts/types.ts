export interface NotebookLMCookieFileV1 {
    version: 1;
    updatedAt: string;
    cookieMap: Record<string, string>;
}

export interface NotebookInfo {
    id: string;
    name: string;
    url: string;
    description?: string;
    topics?: string[];
    addedAt: string;
    lastUsed?: string;
    useCount: number;
}

export interface LibraryFile {
    version: 1;
    notebooks: NotebookInfo[];
    activeNotebookId?: string;
}

export type ArtifactType =
    | 'audio'
    | 'video'
    | 'report'
    | 'quiz'
    | 'flashcards'
    | 'mind_map'
    | 'infographic'
    | 'slide_deck'
    | 'data_table';

export interface ArtifactConfig {
    type: ArtifactType;
    notebookId: string;
    sourceIds?: string[];
    instructions?: string;
    language?: string;
    // Audio
    audioFormat?: 'deep_dive' | 'brief' | 'critique' | 'debate';
    audioLength?: 'short' | 'default' | 'long';
    // Video
    videoStyle?:
        | 'auto'
        | 'custom'
        | 'classic'
        | 'whiteboard'
        | 'kawaii'
        | 'anime'
        | 'watercolor'
        | 'retro_print'
        | 'heritage'
        | 'paper_craft';
    videoFormat?: 'explainer' | 'brief' | 'cinematic' | 'short';
    /** Free-text style description, only used when videoStyle === 'custom'. */
    videoStylePrompt?: string;
    // Quiz/Flashcards
    difficulty?: 'easy' | 'medium' | 'hard';
    quantity?: 'fewer' | 'standard' | 'more';
    // Slide deck
    slideDeckFormat?: 'detailed' | 'presenter';
    slideDeckLength?: 'default' | 'short';
    // Infographic
    infographicOrientation?: 'landscape' | 'portrait' | 'square';
    infographicDetail?: 'concise' | 'standard' | 'detailed';
    infographicStyle?:
        | 'auto'
        | 'sketch_note'
        | 'professional'
        | 'bento_grid'
        | 'editorial'
        | 'instructional'
        | 'bricks'
        | 'clay'
        | 'anime'
        | 'kawaii'
        | 'scientific';
    // Report
    reportFormat?: 'briefing' | 'study_guide' | 'blog_post' | 'custom';
    /** Full prompt for reportFormat === 'custom' (defaults to a generic report prompt). */
    reportPrompt?: string;
}

export interface ArtifactResult {
    id: string;
    type: ArtifactType;
    status: 'processing' | 'pending' | 'completed' | 'failed';
    title?: string;
    downloadUrl?: string;
    /** Alternate download URL (slide decks: PDF when downloadUrl is PPTX). */
    alternateUrl?: string;
    content?: string;
    filePath?: string;
    downloadError?: string;
}

export type LogFn = (message: string) => void;
