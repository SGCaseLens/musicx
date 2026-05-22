import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LyricsPanel } from "./LyricsPanel";
import type { TranslateFn } from "../i18n";
import type { Track } from "../types";

const t: TranslateFn = (key) => {
  const labels: Partial<Record<Parameters<TranslateFn>[0], string>> = {
    lyricsTitle: "Lyrics",
    lyricsDescription: "Timed lyrics",
    lyricsLoadAction: "Find lyrics",
    lyricsLoading: "Searching lyrics...",
    lyricsTimelineLabel: "Timeline",
    lyricsOffsetLabel: "Lyric offset",
    lyricsOffsetEarlier: "-0.5s",
    lyricsOffsetReset: "Reset",
    lyricsOffsetLater: "+0.5s",
    lyricsSourceLabel: "Source",
    lyricsSelectHint: "Pick a track",
    lyricsEmptyTitle: "No lyrics yet",
    lyricsEmptyDescription: "Search lyrics",
  };
  return labels[key] ?? key;
};

const track: Track = {
  id: "track-lyrics",
  title: "Offset Song",
  artist: "musicx",
  source: "local",
  durationSec: 30,
  lyrics: [
    { id: "line-1", time: 0, text: "Intro" },
    { id: "line-2", time: 10, text: "Chorus" },
  ],
};

describe("LyricsPanel", () => {
  it("uses the saved lyric offset when choosing the active line", () => {
    render(
      <LyricsPanel
        track={track}
        currentTime={9.8}
        isLoading={false}
        lyricOffsetMs={-500}
        onLyricOffsetChange={vi.fn()}
        onRefreshLyrics={vi.fn()}
        t={t}
      />,
    );

    expect(screen.getByText("Chorus").closest(".lyric-line")).toHaveClass(
      "lyric-line--active",
    );
    expect(screen.getByText("Intro").closest(".lyric-line")).not.toHaveClass(
      "lyric-line--active",
    );
  });

  it("emits precise half-second offset adjustments", async () => {
    const user = userEvent.setup();
    const onLyricOffsetChange = vi.fn();

    render(
      <LyricsPanel
        track={track}
        currentTime={4}
        isLoading={false}
        lyricOffsetMs={1_000}
        onLyricOffsetChange={onLyricOffsetChange}
        onRefreshLyrics={vi.fn()}
        t={t}
      />,
    );

    await user.click(screen.getByRole("button", { name: "-0.5s" }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "+0.5s" }));

    expect(onLyricOffsetChange).toHaveBeenNthCalledWith(1, 500);
    expect(onLyricOffsetChange).toHaveBeenNthCalledWith(2, 0);
    expect(onLyricOffsetChange).toHaveBeenNthCalledWith(3, 1_500);
  });
});
