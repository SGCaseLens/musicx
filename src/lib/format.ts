import type { Locale, NoticeTone, Track } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatDuration(seconds?: number | null): string {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds === null) {
    return "--:--";
  }

  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function formatTrackMeta(
  track: Track,
  fallbackArtist: string,
  fallbackAlbum: string,
): string {
  const artist = track.artist.trim() || fallbackArtist;
  const album = track.album?.trim() || fallbackAlbum;
  return `${artist} • ${album}`;
}

export function getTrackSearchText(track: Track): string {
  return [
    track.title,
    track.artist,
    track.album ?? "",
    track.youtubeId ?? "",
    track.filePath ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function filterTracks(tracks: Track[], query: string): Track[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return tracks;
  }

  return tracks.filter((track) => getTrackSearchText(track).includes(normalizedQuery));
}

export function trackSourceLabel(
  source: Track["source"],
  locale: Locale,
): string {
  const labels = {
    en: {
      local: "Local",
      youtube: "YouTube",
      demo: "Demo",
      unknown: "Unknown",
    },
    "zh-CN": {
      local: "本地",
      youtube: "YouTube",
      demo: "演示",
      unknown: "未知",
    },
  } as const;

  return labels[locale][source];
}

export function sourceAccent(source: Track["source"]): string {
  switch (source) {
    case "youtube":
      return "source-youtube";
    case "local":
      return "source-local";
    case "demo":
      return "source-demo";
    default:
      return "source-unknown";
  }
}

export function initialsFromTitle(title: string): string {
  const clean = title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return clean || "MX";
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (Array.isArray(error)) {
    const messages = error
      .map((item) => toErrorMessage(item))
      .filter((message) => message && message !== "Unknown error");
    if (messages.length) {
      return messages.join(" | ");
    }
  }

  if (isRecord(error)) {
    const candidates = [
      error.message,
      error.error,
      error.reason,
      error.details,
      error.detail,
      error.cause,
    ];

    for (const candidate of candidates) {
      const message = toErrorMessage(candidate);
      if (message && message !== "Unknown error") {
        return message;
      }
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Ignore non-serializable objects and fall through to the generic message.
    }
  }

  return "Unknown error";
}

export function toneFromError(error: unknown): NoticeTone {
  return toErrorMessage(error).toLowerCase().includes("not found")
    ? "neutral"
    : "danger";
}

export function formatTimestamp(dateString: string | undefined, locale: Locale): string {
  if (!dateString) {
    return "";
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function mergeTrackCollections(previous: Track[], incoming: Track[]): Track[] {
  const previousById = new Map(previous.map((track) => [track.id, track]));

  return incoming.map((track) => {
    const existing = previousById.get(track.id);
    if (!existing) {
      return track;
    }

    return {
      ...existing,
      ...track,
      lyrics: track.lyrics?.length ? track.lyrics : existing.lyrics,
      lyricSource: track.lyricSource ?? existing.lyricSource,
      lyricOffsetMs: track.lyricOffsetMs ?? existing.lyricOffsetMs,
      artworkPath: track.artworkPath ?? existing.artworkPath,
      artworkUrl: track.artworkUrl ?? existing.artworkUrl,
    };
  });
}
