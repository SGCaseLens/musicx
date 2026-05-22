import { describe, expect, it } from "vitest";

import {
  addTrackToQueue,
  materializeQueue,
  removeTrackFromQueue,
  sortLibraryTracks,
} from "./library";
import type { Track } from "../types";

function track(input: Partial<Track> & Pick<Track, "id" | "title">): Track {
  return {
    artist: "Artist",
    source: "local",
    ...input,
  };
}

describe("library utilities", () => {
  it("sorts tracks by title and recent play metadata", () => {
    const tracks = [
      track({ id: "b", title: "Beta", lastPlayedAt: "2026-05-22T10:00:00Z" }),
      track({ id: "a", title: "alpha", lastPlayedAt: "2026-05-22T12:00:00Z" }),
      track({ id: "c", title: "Cloud", lastPlayedAt: undefined }),
    ];

    expect(sortLibraryTracks(tracks, "title", "asc").map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortLibraryTracks(tracks, "lastPlayed", "desc").map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("deduplicates queue operations while preserving up-next order", () => {
    expect(addTrackToQueue(["a", "b"], "c", "end")).toEqual(["a", "b", "c"]);
    expect(addTrackToQueue(["a", "b"], "b", "next")).toEqual(["b", "a"]);
    expect(removeTrackFromQueue(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("materializes queue ids and drops stale tracks", () => {
    const tracks = [track({ id: "a", title: "A" }), track({ id: "b", title: "B" })];

    expect(materializeQueue(["missing", "b", "a"], tracks).map((item) => item.id)).toEqual([
      "b",
      "a",
    ]);
  });
});
