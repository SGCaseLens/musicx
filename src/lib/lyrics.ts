import type { LyricsLine } from "../types";

function makeLine(time: number, text: string, index: number, translation?: string): LyricsLine {
  return {
    id: `lyric-${index}-${Math.round(time * 1000)}`,
    time,
    text: text.trim(),
    translation: translation?.trim() || undefined,
  };
}

function parseTimestamp(raw: string): number {
  const parts = raw.replace(",", ".").split(":");
  const numeric = parts.map((part) => Number(part));

  if (numeric.some((part) => Number.isNaN(part))) {
    return 0;
  }

  if (numeric.length === 3) {
    return numeric[0] * 3600 + numeric[1] * 60 + numeric[2];
  }

  if (numeric.length === 2) {
    return numeric[0] * 60 + numeric[1];
  }

  return numeric[0] ?? 0;
}

function parseLrc(text: string): LyricsLine[] {
  const lines = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  const parsed: LyricsLine[] = [];
  const stampPattern = /\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g;

  lines.forEach((row) => {
    const timestamps = [...row.matchAll(stampPattern)];
    const content = row.replace(stampPattern, "").trim();

    timestamps.forEach((match, index) => {
      const [minutesPart, secondsPart] = match[1].split(":");
      const minutes = Number(minutesPart);
      const seconds = Number(secondsPart?.replace(",", "."));
      const time =
        Number.isFinite(minutes) && Number.isFinite(seconds)
          ? minutes * 60 + seconds
          : 0;
      parsed.push(makeLine(time, content || "…", parsed.length + index));
    });
  });

  return parsed.sort((a, b) => a.time - b.time);
}

function parseSubtitle(text: string): LyricsLine[] {
  const blocks = text
    .replace(/^WEBVTT\s*/i, "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed: LyricsLine[] = [];
  const rangePattern =
    /(\d{2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/;

  blocks.forEach((block) => {
    const rows = block.split(/\r?\n/).filter(Boolean);
    const timeRow = rows.find((row) => rangePattern.test(row));
    if (!timeRow) {
      return;
    }

    const match = timeRow.match(rangePattern);
    if (!match) {
      return;
    }

    const textRows = rows
      .filter((row) => row !== timeRow && !/^\d+$/.test(row.trim()))
      .map((row) => row.trim());

    if (!textRows.length) {
      return;
    }

    const [primary, translation] = textRows.join(" ").split(" / ");
    parsed.push(
      makeLine(
        parseTimestamp(match[1].replace(",", ".")),
        primary,
        parsed.length,
        translation,
      ),
    );
  });

  return parsed.sort((a, b) => a.time - b.time);
}

function parsePlainText(text: string): LyricsLine[] {
  return text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row, index) => {
      const [primary, translation] = row.split(" / ");
      return makeLine(index * 4.5, primary, index, translation);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeLyrics(input: unknown): LyricsLine[] {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input
      .map((line, index) => {
        if (typeof line === "string") {
          return makeLine(index * 4.5, line, index);
        }

        if (!isRecord(line)) {
          return null;
        }

        const text =
          (typeof line.text === "string" && line.text) ||
          (typeof line.lyric === "string" && line.lyric) ||
          (typeof line.content === "string" && line.content) ||
          "";

        if (!text) {
          return null;
        }

        const timeValue =
          (typeof line.time === "number" && line.time) ||
          (typeof line.timeMs === "number" && line.timeMs / 1000) ||
          (typeof line.startMs === "number" && line.startMs / 1000) ||
          (typeof line.timestamp === "number" && line.timestamp) ||
          (typeof line.start === "number" && line.start) ||
          0;

        const translation =
          (typeof line.translation === "string" && line.translation) ||
          (typeof line.translated === "string" && line.translated) ||
          undefined;

        return makeLine(timeValue, text, index, translation);
      })
      .filter((line): line is LyricsLine => Boolean(line))
      .sort((a, b) => a.time - b.time);
  }

  if (typeof input === "string") {
    if (/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(input)) {
      return parseLrc(input);
    }

    if (/-->/.test(input)) {
      return parseSubtitle(input);
    }

    return parsePlainText(input);
  }

  if (isRecord(input)) {
    if (Array.isArray(input.lines)) {
      return normalizeLyrics(input.lines);
    }

    if (typeof input.lyrics === "string" || Array.isArray(input.lyrics)) {
      return normalizeLyrics(input.lyrics);
    }

    if (typeof input.content === "string") {
      return normalizeLyrics(input.content);
    }
  }

  return [];
}

export function findActiveLyricIndex(lines: LyricsLine[], currentTime: number): number {
  if (!lines.length) {
    return -1;
  }

  let low = 0;
  let high = lines.length - 1;
  let activeIndex = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= currentTime) {
      activeIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return activeIndex;
}
