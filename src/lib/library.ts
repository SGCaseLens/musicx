import type { LibrarySortMode, SortDirection, Track } from "../types";

function normalized(value?: string | null): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function timestamp(value?: string): number {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function compareTrackByMode(
  left: Track,
  right: Track,
  mode: LibrarySortMode,
): number {
  switch (mode) {
    case "title":
      return (
        compareText(normalized(left.title), normalized(right.title)) ||
        compareText(normalized(left.artist), normalized(right.artist))
      );
    case "artist":
      return (
        compareText(normalized(left.artist), normalized(right.artist)) ||
        compareText(normalized(left.title), normalized(right.title))
      );
    case "duration":
      return (left.durationSec ?? 0) - (right.durationSec ?? 0);
    case "lastPlayed":
      return timestamp(left.lastPlayedAt) - timestamp(right.lastPlayedAt);
    case "added":
    default:
      return timestamp(left.importedAt) - timestamp(right.importedAt);
  }
}

export function sortLibraryTracks(
  tracks: Track[],
  mode: LibrarySortMode,
  direction: SortDirection,
): Track[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...tracks].sort((left, right) => {
    const primary = compareTrackByMode(left, right, mode) * multiplier;
    if (primary !== 0) {
      return primary;
    }

    return compareText(normalized(left.title), normalized(right.title));
  });
}

export function addTrackToQueue(
  queueTrackIds: string[],
  trackId: string,
  placement: "next" | "end",
): string[] {
  const deduped = queueTrackIds.filter((queuedTrackId) => queuedTrackId !== trackId);
  const nextQueue = placement === "next" ? [trackId, ...deduped] : [...deduped, trackId];
  return nextQueue.slice(0, 250);
}

export function removeTrackFromQueue(queueTrackIds: string[], trackId: string): string[] {
  return queueTrackIds.filter((queuedTrackId) => queuedTrackId !== trackId);
}

export function materializeQueue(queueTrackIds: string[], tracks: Track[]): Track[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return queueTrackIds
    .map((trackId) => byId.get(trackId))
    .filter((track): track is Track => Boolean(track));
}
