import { useEffect, useEffectEvent, useRef } from "react";

import { Clock3, TextQuote } from "lucide-react";

import { formatDuration } from "../lib/format";
import { findActiveLyricIndex } from "../lib/lyrics";
import type { TranslateFn } from "../i18n";
import type { NoticeTone, Track } from "../types";

interface LyricsPanelProps {
  track: Track | null;
  currentTime: number;
  isLoading: boolean;
  error?: string;
  status?: string | null;
  statusTone?: NoticeTone;
  onRefreshLyrics: () => void | Promise<void>;
  t: TranslateFn;
}

export function LyricsPanel({
  track,
  currentTime,
  isLoading,
  error,
  status,
  statusTone = "neutral",
  onRefreshLyrics,
  t,
}: LyricsPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledIndexRef = useRef(-1);
  const lyrics = track?.lyrics ?? [];
  const activeIndex = findActiveLyricIndex(lyrics, currentTime);

  const scrollActiveLine = useEffectEvent((index: number) => {
    const container = containerRef.current;
    const activeLine = container?.querySelector<HTMLElement>(
      `[data-lyric-index="${index}"]`,
    );
    if (!container || !activeLine) {
      return;
    }

    const maxScrollTop = container.scrollHeight - container.clientHeight;
    if (maxScrollTop <= 4) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const lineRect = activeLine.getBoundingClientRect();
    const targetTop = Math.min(
      maxScrollTop,
      Math.max(
        0,
        container.scrollTop + lineRect.top - containerRect.top - container.clientHeight * 0.36,
      ),
    );
    if (Math.abs(container.scrollTop - targetTop) < 18) {
      return;
    }

    container.scrollTo({
      top: targetTop,
      behavior: "auto",
    });
  });

  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }

    if (lastScrolledIndexRef.current === activeIndex) {
      return;
    }
    lastScrolledIndexRef.current = activeIndex;

    const frameId = window.requestAnimationFrame(() => {
      scrollActiveLine(activeIndex);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeIndex, track?.id]);

  useEffect(() => {
    lastScrolledIndexRef.current = -1;
  }, [track?.id]);

  return (
    <section className="lyrics-card">
      <header className="lyrics-card__header">
        <div>
          <p className="lyrics-card__eyebrow">{t("lyricsTitle")}</p>
          <h2 className="lyrics-card__title">{t("lyricsDescription")}</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void onRefreshLyrics()}
          disabled={!track || isLoading}
        >
          <TextQuote size={15} strokeWidth={2.2} aria-hidden="true" />
          {isLoading ? t("lyricsLoading") : t("lyricsLoadAction")}
        </button>
      </header>

      {track ? (
        <div className="lyrics-card__summary">
          <span className="chip chip--soft">
            <Clock3 size={15} strokeWidth={2.2} aria-hidden="true" />
            {t("lyricsTimelineLabel")}: {formatDuration(currentTime)}
          </span>
          {track.lyricSource ? (
            <span className="chip chip--soft">
              {t("lyricsSourceLabel")}: {track.lyricSource}
            </span>
          ) : null}
        </div>
      ) : null}

      {status ? (
        <div className={["context-message", `context-message--${statusTone}`].join(" ")}>
          {status}
        </div>
      ) : null}

      {!track ? (
        <div className="empty-state empty-state--spacious">
          <h3>{t("lyricsTitle")}</h3>
          <p>{t("lyricsSelectHint")}</p>
        </div>
      ) : lyrics.length ? (
        <div className="lyrics-scroll" ref={containerRef}>
          <div className="lyrics-lines">
            {lyrics.map((line, index) => {
              const isActive = index === activeIndex;
              return (
                <div
                  key={line.id}
                  className={["lyric-line", isActive ? "lyric-line--active" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  data-active={isActive ? "true" : "false"}
                  data-lyric-index={index}
                >
                  <span className="lyric-line__time">{formatDuration(line.time)}</span>
                  <div className="lyric-line__copy">
                    <p>{line.text}</p>
                    {line.translation ? <span>{line.translation}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="empty-state empty-state--spacious">
          <h3>{t("lyricsEmptyTitle")}</h3>
          <p>{t("lyricsEmptyDescription")}</p>
        </div>
      )}

      {error ? <p className="inline-error inline-error--foot">{error}</p> : null}
    </section>
  );
}
