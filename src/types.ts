export type Locale = "en" | "zh-CN";

export type RuntimeMode = "desktop" | "browser";

export type NoticeTone = "neutral" | "success" | "danger";

export type PlaybackOrderMode = "normal" | "shuffle";

export type RepeatMode = "off" | "all" | "one";

export type DownloadPhase =
  | "queued"
  | "searching"
  | "downloading"
  | "converting"
  | "writing"
  | "done"
  | "error";

export interface LyricsLine {
  id: string;
  time: number;
  text: string;
  translation?: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number | null;
  filePath?: string;
  audioPath?: string;
  artworkPath?: string;
  artworkUrl?: string;
  language?: string;
  lyrics?: LyricsLine[];
  lyricSource?: string;
  lyricOffsetMs?: number;
  importedAt?: string;
  youtubeId?: string;
  source: "local" | "youtube" | "demo" | "unknown";
}

export interface BootstrapResult {
  locale?: Locale;
  tracks: Track[];
  appDataDir?: string;
  libraryDir?: string;
  dependencyStatus?: {
    ytDlpReady: boolean;
    ffmpegReady: boolean;
  };
  libraryName?: string;
  lastIndexedAt?: string;
}

export interface ImportResult {
  tracks: Track[];
  imported: number;
  skipped: number;
  warnings: string[];
  cancelled?: boolean;
}

export interface DeleteTrackResult {
  deletedTrackId?: string | null;
  warnings: string[];
}

export interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  durationSec?: number | null;
  thumbnailUrl?: string;
  publishedAt?: string;
  description?: string;
  url?: string;
}

export interface DownloadProgress {
  videoId?: string;
  title?: string;
  progress: number;
  phase: DownloadPhase;
  message?: string;
  etaSeconds?: number | null;
  track?: Track;
}

export interface Notice {
  tone: NoticeTone;
  text: string;
}
