import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { getPreferredLocale } from "../i18n";
import type {
  BootstrapResult,
  DeleteTrackResult,
  DownloadPhase,
  DownloadProgress,
  ImportResult,
  Locale,
  RuntimeMode,
  Track,
  YouTubeVideo,
} from "../types";
import { clamp, toErrorMessage } from "./format";
import { normalizeLyrics } from "./lyrics";
import {
  buildMockDownloadSequence,
  deleteMockTrack,
  getMockBootstrap,
  getMockTracks,
  searchMockLyrics,
  searchMockVideos,
  simulateDownloadedTrack,
  simulateLocalImport,
} from "./mockData";

const DOWNLOAD_EVENT_NAME = "youtube-download-progress";
const browserEvents = new EventTarget();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapPayload<T>(input: unknown): T | unknown {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        return input;
      }
    }
  }

  if (isRecord(input)) {
    const nested = input.data ?? input.payload ?? input.result;
    if (nested !== undefined) {
      return unwrapPayload<T>(nested);
    }
  }

  return input;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function normalizeLocale(input: unknown): BootstrapResult["locale"] {
  if (typeof input !== "string") {
    return getPreferredLocale();
  }

  return input.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function normalizeTrack(input: unknown, index: number): Track | null {
  input = unwrapPayload(input);
  if (!isRecord(input)) {
    return null;
  }

  const durationMs = readNumber(input, ["durationMs", "duration_ms"]);
  const sourceKind = readString(input, ["sourceKind", "source_kind", "source"]) ?? "unknown";
  const source: Track["source"] =
    sourceKind === "local" || sourceKind === "youtube" || sourceKind === "demo"
      ? sourceKind
      : "unknown";

  const lyrics = normalizeLyrics(input.lyrics);
  const lyricsSource = (() => {
    if (!isRecord(input.lyrics)) {
      return readString(input, ["lyricSource", "lyric_source"]);
    }

    const sourceLabel = readString(input.lyrics, ["provider", "sourceLabel", "source_label"]);
    const sourceKind = readString(input.lyrics, ["sourceKind", "source_kind", "source"]);
    return [sourceKind, sourceLabel].filter(Boolean).join(" / ") || undefined;
  })();

  const filePath = readString(input, ["filePath", "file_path", "audioPath", "audio_path"]);

  return {
    id: readString(input, ["id"]) ?? `track-${index}`,
    title: readString(input, ["title"]) ?? `Track ${index + 1}`,
    artist: readString(input, ["artist"]) ?? "Unknown artist",
    album: readString(input, ["album"]),
    durationSec:
      durationMs !== undefined
        ? durationMs / 1000
        : readNumber(input, ["durationSec", "duration", "duration_seconds"]) ?? null,
    filePath,
    audioPath: filePath,
    artworkPath: readString(input, ["coverArtPath", "cover_art_path", "artworkPath", "artwork_path"]),
    artworkUrl: readString(input, ["artworkUrl", "artwork_url", "thumbnailUrl", "thumbnail_url"]),
    lyrics,
    lyricSource: lyricsSource,
    importedAt: readString(input, ["createdAt", "created_at", "importedAt", "imported_at"]),
    youtubeId: readString(input, ["youtubeVideoId", "youtube_video_id", "youtubeId", "youtube_id"]),
    source,
    language: readString(input, ["language", "lang"]),
  };
}

function normalizeTracks(input: unknown): Track[] {
  input = unwrapPayload(input);
  if (Array.isArray(input)) {
    return input
      .map((track, index) => normalizeTrack(track, index))
      .filter((track): track is Track => Boolean(track));
  }

  if (isRecord(input) && Array.isArray(input.tracks)) {
    return normalizeTracks(input.tracks);
  }

  return [];
}

function normalizeBootstrap(input: unknown): BootstrapResult {
  input = unwrapPayload(input);
  if (!isRecord(input)) {
    return getMockBootstrap(getPreferredLocale());
  }

  return {
    locale: normalizeLocale(input.locale),
    tracks: normalizeTracks(input.tracks),
    appDataDir: readString(input, ["appDataDir", "app_data_dir"]),
    libraryDir: readString(input, ["libraryDir", "library_dir"]),
    dependencyStatus: isRecord(input.dependencyStatus)
      ? {
          ytDlpReady: Boolean(input.dependencyStatus.ytDlpReady),
          ffmpegReady: Boolean(input.dependencyStatus.ffmpegReady),
        }
      : undefined,
  };
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeImportResult(input: unknown): ImportResult {
  input = unwrapPayload(input);
  const tracks = normalizeTracks(input);

  if (!isRecord(input)) {
    return {
      tracks,
      imported: tracks.length,
      skipped: 0,
      warnings: [],
    };
  }

  return {
    tracks,
    imported: readNumber(input, ["imported"]) ?? tracks.length,
    skipped: readNumber(input, ["skipped"]) ?? 0,
    warnings: normalizeStringList(input.warnings),
  };
}

function normalizeDeleteTrackResult(input: unknown): DeleteTrackResult {
  input = unwrapPayload(input);
  if (!isRecord(input)) {
    return {
      deletedTrackId: undefined,
      warnings: [],
    };
  }

  return {
    deletedTrackId: readString(input, ["deletedTrackId", "deleted_track_id"]) ?? null,
    warnings: normalizeStringList(input.warnings),
  };
}

function normalizeVideos(input: unknown): YouTubeVideo[] {
  input = unwrapPayload(input);
  if (Array.isArray(input)) {
    const videos: YouTubeVideo[] = [];
    input.forEach((item, index) => {
      if (!isRecord(item)) {
        return;
      }

      const durationMs = readNumber(item, ["durationMs", "duration_ms"]);
      const durationSeconds =
        durationMs !== undefined
          ? durationMs / 1000
          : readNumber(item, ["durationSec", "duration", "duration_seconds"]) ?? null;

      videos.push({
        id: readString(item, ["id"]) ?? `video-${index}`,
        title: readString(item, ["title"]) ?? `Result ${index + 1}`,
        channel:
          readString(item, ["channel", "channelName", "channel_name", "uploader"]) ??
          "Unknown channel",
        durationSec: durationSeconds,
        thumbnailUrl: readString(item, ["thumbnailUrl", "thumbnail_url", "thumbnail"]),
        description: readString(item, ["description"]),
        publishedAt: readString(item, ["publishedAt", "published_at", "uploadDate", "upload_date"]),
        url: readString(item, ["webpageUrl", "webpage_url", "url"]),
      });
    });
    return videos;
  }

  return [];
}

function normalizeVolume(input: unknown): number {
  const value = typeof input === "number" && Number.isFinite(input) ? input : 0;
  return clamp(value, 0, 1);
}

function normalizePhase(input: unknown): DownloadPhase {
  if (typeof input !== "string") {
    return "queued";
  }

  switch (input) {
    case "preflight":
    case "prepare":
    case "searching":
      return "searching";
    case "downloading_audio":
    case "download":
    case "downloading":
      return "downloading";
    case "extracting_mp3":
    case "postprocess":
    case "transcoding":
    case "converting":
      return "converting";
    case "moving_files":
    case "writing":
    case "finalizing":
    case "lyrics-warning":
      return "writing";
    case "completed":
    case "done":
      return "done";
    case "failed":
    case "error":
      return "error";
    default:
      return "queued";
  }
}

function normalizeProgress(input: unknown): DownloadProgress {
  input = unwrapPayload(input);
  if (!isRecord(input)) {
    return {
      phase: "queued",
      progress: 0,
    };
  }

  const rawProgress = readNumber(input, ["progress", "percent", "percentage"]) ?? 0;
  const normalizedProgress = rawProgress <= 1 ? rawProgress * 100 : rawProgress;
  return {
    videoId: readString(input, ["videoId", "video_id"]),
    title: readString(input, ["title"]),
    phase: normalizePhase(input.stage ?? input.status ?? input.phase),
    progress: Math.min(100, Math.max(0, normalizedProgress)),
    message: readString(input, ["message", "detail"]),
    etaSeconds: readNumber(input, ["etaSeconds", "eta_seconds", "eta"]) ?? null,
    track: normalizeTrack(input.track, 0) ?? undefined,
  };
}

function emitBrowserProgress(progress: DownloadProgress): void {
  browserEvents.dispatchEvent(
    new CustomEvent<DownloadProgress>(DOWNLOAD_EVENT_NAME, { detail: progress }),
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const message = toErrorMessage(error);
    throw error instanceof Error && error.message === message ? error : new Error(message);
  }
}

export function getRuntimeMode(): RuntimeMode {
  return isTauri() ? "desktop" : "browser";
}

export function resolveMediaUrl(path?: string): string | undefined {
  if (!path) {
    return undefined;
  }

  if (/^(https?:|data:|blob:|asset:)/.test(path)) {
    return path;
  }

  return isTauri() ? convertFileSrc(path) : undefined;
}

export async function getSystemOutputVolume(): Promise<number | null> {
  if (!isTauri()) {
    return null;
  }

  const response = await invokeCommand("get_system_output_volume");
  return normalizeVolume(response);
}

export async function setSystemOutputVolume(volume: number): Promise<number> {
  const safeVolume = clamp(volume, 0, 1);
  if (!isTauri()) {
    return safeVolume;
  }

  const response = await invokeCommand("set_system_output_volume", {
    volume: safeVolume,
  });
  return normalizeVolume(response);
}

export async function bootstrapApp(): Promise<BootstrapResult> {
  if (!isTauri()) {
    return getMockBootstrap(getPreferredLocale());
  }

  const response = await invokeCommand("bootstrap_app");
  return normalizeBootstrap(response);
}

export async function openSavedLibrary(): Promise<void> {
  if (!isTauri()) {
    return;
  }

  await invokeCommand("open_library_folder");
}

export async function listTracks(): Promise<Track[]> {
  if (!isTauri()) {
    return getMockTracks();
  }

  const response = await invokeCommand("list_tracks");
  return normalizeTracks(response);
}

export async function importLocalTracks(): Promise<ImportResult> {
  if (!isTauri()) {
    await sleep(500);
    const tracks = simulateLocalImport();
    return {
      tracks,
      imported: tracks.length,
      skipped: 0,
      warnings: [],
    };
  }

  const selection = await open({
    multiple: true,
    filters: [
      {
        name: "Audio",
        extensions: ["mp3", "m4a", "wav", "flac", "aac", "ogg"],
      },
    ],
  });
  if (!selection) {
    return {
      tracks: [],
      imported: 0,
      skipped: 0,
      warnings: [],
      cancelled: true,
    };
  }

  const paths = Array.isArray(selection) ? selection : [selection];
  const response = await invokeCommand("import_local_tracks", { paths });
  return normalizeImportResult(response);
}

export async function deleteTrack(trackId: string): Promise<DeleteTrackResult> {
  if (!isTauri()) {
    await sleep(160);
    return {
      deletedTrackId: deleteMockTrack(trackId) ? trackId : null,
      warnings: [],
    };
  }

  const response = await invokeCommand("delete_track", { trackId });
  return normalizeDeleteTrackResult(response);
}

export async function searchLyricsForTrack(track: Track): Promise<Track["lyrics"]> {
  if (track.lyrics?.length) {
    return track.lyrics;
  }

  if (!isTauri()) {
    await sleep(360);
    return searchMockLyrics(track);
  }

  const response = await invokeCommand("search_lyrics_for_track", {
    trackId: track.id,
  });
  const nextTrack = normalizeTrack(response, 0);
  return nextTrack?.lyrics ?? [];
}

export async function searchYoutubeVideos(query: string): Promise<YouTubeVideo[]> {
  if (!isTauri()) {
    await sleep(420);
    return searchMockVideos(query);
  }

  const response = await invokeCommand("search_youtube_videos", { query, limit: 10 });
  return normalizeVideos(response);
}

export async function downloadYoutubeAudio(
  video: YouTubeVideo,
  preferredLanguage?: Locale,
): Promise<Track | null> {
  if (!isTauri()) {
    const track = simulateDownloadedTrack(video);
    for (const progress of buildMockDownloadSequence(video)) {
      emitBrowserProgress(progress);
      await sleep(progress.phase === "done" ? 120 : 280);
    }
    return track;
  }

  const response = await invokeCommand("download_youtube_audio", {
    request: {
      videoId: video.id,
      title: video.title,
      url: video.url,
      preferredLanguage: preferredLanguage ?? getPreferredLocale(),
    },
  });
  return normalizeTrack(response, 0);
}

export async function subscribeToDownloadProgress(
  handler: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    const listener = (event: Event) => {
      handler(normalizeProgress((event as CustomEvent<DownloadProgress>).detail));
    };

    browserEvents.addEventListener(DOWNLOAD_EVENT_NAME, listener as EventListener);

    return async () => {
      browserEvents.removeEventListener(
        DOWNLOAD_EVENT_NAME,
        listener as EventListener,
      );
    };
  }

  return listen(DOWNLOAD_EVENT_NAME, (event) => {
    handler(normalizeProgress(event.payload));
  });
}
