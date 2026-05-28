export type SubtitleSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type SubtitleTrack = {
  recordingId: string;
  generatedAt: string;
  model: string;
  source: "huggingface-local" | "backend-job";
  language?: string;
  segments: SubtitleSegment[];
};

export type SubtitleChapter = {
  id: string;
  title: string;
  startMs: number;
  endMs?: number;
};

export type SubtitleCorrectionResult = {
  segments: Array<{
    id: string;
    text: string;
  }>;
  chapters?: Array<{
    title: string;
    startMs: number;
    endMs?: number;
  }>;
};

export type SubtitleCorrectionWarning = {
  code: "invalid-correction" | "invalid-chapter";
  message: string;
};

export type SubtitleTrackDraft = Omit<SubtitleTrack, "recordingId" | "generatedAt">;

export type SubtitleTranscriberInput = {
  mediaBlob: Blob;
  durationMs: number;
  signal?: AbortSignal;
};

export type SubtitleTranscriber = {
  warmUp?(): Promise<void>;
  transcribe(input: SubtitleTranscriberInput): Promise<SubtitleTrackDraft>;
};

export type SubtitleStore = {
  load(recordingId: string): Promise<SubtitleTrack | null>;
  save(track: SubtitleTrack): Promise<void>;
  remove(recordingId: string): Promise<void>;
};
