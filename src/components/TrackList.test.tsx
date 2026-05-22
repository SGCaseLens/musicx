import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TrackList } from "./TrackList";
import type { TranslateFn } from "../i18n";
import type { Track } from "../types";

const t: TranslateFn = (key) => {
  const labels: Partial<Record<Parameters<TranslateFn>[0], string>> = {
    libraryEmptyTitle: "No tracks yet",
    libraryEmptyDescription: "Import music",
    libraryFilterFavorites: "Favorites",
    trackUnknownArtist: "Unknown artist",
    trackUnknownAlbum: "Unsorted release",
    trackDurationUnknown: "--:--",
    trackImportedLabel: "Imported",
    trackLastPlayedLabel: "Last played",
    trackQueuedLabel: "Queued",
    trackPlay: "Play",
    trackPause: "Pause",
    trackDelete: "Delete song",
    trackFavorite: "Add to favorites",
    trackUnfavorite: "Remove from favorites",
    trackAddToQueue: "Add to queue",
    trackRemoveFromQueue: "Remove from queue",
    trackMoreActions: "More actions",
  };
  return labels[key] ?? key;
};

const track: Track = {
  id: "song-1",
  title: "Library Song",
  artist: "musicx",
  source: "local",
  durationSec: 182,
};

function renderTrackList(overrides: Partial<Parameters<typeof TrackList>[0]> = {}) {
  const props = {
    tracks: [track],
    selectedTrackId: null,
    currentTrackId: null,
    isPlaying: false,
    locale: "en" as const,
    queuedTrackIds: [],
    onSelect: vi.fn(),
    onPlay: vi.fn(),
    onToggleFavorite: vi.fn(),
    onAddToQueue: vi.fn(),
    onRemoveFromQueue: vi.fn(),
    onDelete: vi.fn(),
    onOpenMenu: vi.fn(),
    t,
    ...overrides,
  };

  render(<TrackList {...props} />);
  return props;
}

describe("TrackList", () => {
  it("exposes favorite, queue, and overflow actions for each library row", async () => {
    const user = userEvent.setup();
    const props = renderTrackList();

    await user.click(screen.getByRole("button", { name: "Add to favorites" }));
    await user.click(screen.getByRole("button", { name: "Add to queue" }));
    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(props.onToggleFavorite).toHaveBeenCalledWith(track);
    expect(props.onAddToQueue).toHaveBeenCalledWith(track, "end");
    expect(props.onOpenMenu).toHaveBeenCalledWith(track, expect.any(Number), expect.any(Number));
  });

  it("opens the custom context menu from a right click and removes queued tracks", async () => {
    const user = userEvent.setup();
    const props = renderTrackList({ queuedTrackIds: [track.id] });

    fireEvent.contextMenu(screen.getByRole("listitem"), {
      clientX: 120,
      clientY: 240,
    });
    await user.click(screen.getByRole("button", { name: "Remove from queue" }));

    expect(props.onOpenMenu).toHaveBeenCalledWith(track, 120, 240);
    expect(props.onRemoveFromQueue).toHaveBeenCalledWith(track);
  });
});
