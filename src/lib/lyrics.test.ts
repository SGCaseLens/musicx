import { describe, expect, it } from "vitest";

import { findActiveLyricIndex, normalizeLyrics } from "./lyrics";

describe("lyrics utilities", () => {
  it("keeps active lyric lookup stable at exact boundaries", () => {
    const lines = [
      { id: "a", time: 0, text: "A" },
      { id: "b", time: 10, text: "B" },
      { id: "c", time: 20, text: "C" },
    ];

    expect(findActiveLyricIndex(lines, 0)).toBe(0);
    expect(findActiveLyricIndex(lines, 9.99)).toBe(0);
    expect(findActiveLyricIndex(lines, 10)).toBe(1);
    expect(findActiveLyricIndex(lines, 99)).toBe(2);
  });

  it("parses WebVTT into separate timed lines instead of one raw blob", () => {
    const lines = normalizeLyrics(`WEBVTT

00:00:01.000 --> 00:00:02.500
hello

00:00:03.000 --> 00:00:04.500
musicx`);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ time: 1, text: "hello" });
    expect(lines[1]).toMatchObject({ time: 3, text: "musicx" });
  });
});
