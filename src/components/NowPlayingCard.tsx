import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import {
  Disc3,
  Music4,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";

import {
  formatDuration,
  formatTimestamp,
  initialsFromTitle,
  trackSourceLabel,
} from "../lib/format";
import { useAudioMeter } from "../hooks/useAudioMeter";
import type { TranslateFn } from "../i18n";
import type { Locale, PlaybackOrderMode, RepeatMode, Track } from "../types";

interface NowPlayingCardProps {
  track: Track | null;
  artworkUrl?: string;
  locale: Locale;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  canPlay: boolean;
  volume: number;
  error?: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  playbackOrderMode: PlaybackOrderMode;
  repeatMode: RepeatMode;
  canPlayPrevious: boolean;
  canPlayNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onTogglePlaybackOrderMode: () => void;
  onCycleRepeatMode: () => void;
  onTogglePlayback: () => void | Promise<void>;
  onSeek: (seconds: number) => void;
  onVolumeChange: (value: number) => void;
  t: TranslateFn;
}

const meterBars = Array.from({ length: 12 }, (_, index) => index);

interface SignalMeterProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  isPlaying: boolean;
  t: TranslateFn;
}

function SignalMeter({ audioRef, isPlaying, t }: SignalMeterProps) {
  const meterLevels = useAudioMeter(audioRef, isPlaying);

  return (
    <div className="stage-meter" aria-label={t("stageSignalLabel")}>
      <span className="stage-meter__label">{t("stageSignalLabel")}</span>
      <div className="stage-meter__bars" aria-hidden="true">
        {meterBars.map((bar) => {
          const level = Math.min(
            1,
            Math.max(0.04, meterLevels[bar] ?? 0.08 + bar * 0.018),
          );

          return (
            <span
              key={bar}
              className={[
                "stage-meter__bar",
                isPlaying ? "stage-meter__bar--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ "--meter-level": level.toFixed(3) } as CSSProperties}
            />
          );
        })}
      </div>
    </div>
  );
}

export function NowPlayingCard({
  track,
  artworkUrl,
  locale,
  currentTime,
  duration,
  isPlaying,
  canPlay,
  volume,
  error,
  audioRef,
  playbackOrderMode,
  repeatMode,
  canPlayPrevious,
  canPlayNext,
  onPrevious,
  onNext,
  onTogglePlaybackOrderMode,
  onCycleRepeatMode,
  onTogglePlayback,
  onSeek,
  onVolumeChange,
  t,
}: NowPlayingCardProps) {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [draftSeekTime, setDraftSeekTime] = useState(0);
  const draftSeekTimeRef = useRef(0);
  const isScrubbingRef = useRef(false);

  useEffect(() => {
    if (isScrubbing) {
      return;
    }

    draftSeekTimeRef.current = currentTime;
    setDraftSeekTime(currentTime);
  }, [currentTime, isScrubbing]);

  if (!track) {
    return (
      <section className="stage-card stage-card--idle">
        <div className="stage-card__header">
          <div>
            <p className="stage-card__eyebrow">{t("stageDeckLabel")}</p>
            <h2 className="stage-card__title">{t("nowPlayingIdleTitle")}</h2>
            <p className="stage-card__subtitle">{t("nowPlayingIdleDescription")}</p>
          </div>
        </div>

        <div className="stage-card__body">
          <div className="turntable">
            <div className="turntable__base">
              <div className="turntable__record">
                <div className="turntable__groove" />
                <div className="turntable__label turntable__label--placeholder">
                  <Music4 size={42} strokeWidth={1.8} aria-hidden="true" />
                </div>
              </div>
              <div className="turntable__arm" aria-hidden="true" />
            </div>
          </div>

          <div className="stage-display stage-display--idle">
            <div className="empty-state empty-state--stage">
              <h3>{t("nowPlayingIdleTitle")}</h3>
              <p>{t("nowPlayingIdleDescription")}</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const totalDuration = duration || track.durationSec || 0;
  const rangeMax = Math.max(totalDuration, 1);
  const displayedTime = isScrubbing ? draftSeekTime : currentTime;
  const displayedRangeValue = Math.min(displayedTime, rangeMax);
  const progressValue =
    totalDuration > 0 ? Math.min(1, Math.max(0, displayedTime / totalDuration)) : 0;
  const importedAt = formatTimestamp(track.importedAt, locale);
  const repeatLabel =
    repeatMode === "one"
      ? t("repeatOne")
      : repeatMode === "all"
        ? t("repeatAll")
        : t("repeatOff");
  const RepeatIcon = repeatMode === "one" ? Repeat1 : Repeat;
  const previewSeek = (nextTime: number) => {
    const safeTime = Math.min(Math.max(nextTime, 0), rangeMax);
    draftSeekTimeRef.current = safeTime;
    setDraftSeekTime(safeTime);
  };
  const commitSeek = (nextTime = draftSeekTimeRef.current) => {
    const safeTime = Math.min(Math.max(nextTime, 0), rangeMax);
    draftSeekTimeRef.current = safeTime;
    setDraftSeekTime(safeTime);
    isScrubbingRef.current = false;
    setIsScrubbing(false);
    onSeek(safeTime);
  };

  return (
    <section className="stage-card">
      <div className="stage-card__header">
        <div>
          <p className="stage-card__eyebrow">{t("stageDeckLabel")}</p>
          <h2 className="stage-card__title">{track.title}</h2>
          <p className="stage-card__subtitle">{track.artist}</p>
        </div>

        <div className="stage-card__badges">
          <span className="chip">{trackSourceLabel(track.source, locale)}</span>
          <span className="chip chip--soft">
            <Disc3 size={15} strokeWidth={2.2} aria-hidden="true" />
            {isPlaying ? t("trackPause") : t("trackPlay")}
          </span>
        </div>
      </div>

      <div className="stage-card__body stage-card__body--player">
        <div className="stage-display">
          <div className="turntable turntable--stage-top">
            <div className="turntable__base">
              <div
                className={[
                  "turntable__record",
                  isPlaying ? "turntable__record--spinning" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="turntable__groove" />
                <div className="turntable__groove turntable__groove--inner" />
                <div className="turntable__label">
                  {artworkUrl ? (
                    <img src={artworkUrl} alt={track.title} className="turntable__artwork" />
                  ) : (
                    <span>{initialsFromTitle(track.title)}</span>
                  )}
                </div>
              </div>
              <div
                className={[
                  "turntable__arm",
                  isPlaying ? "turntable__arm--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden="true"
              />
            </div>
          </div>

          <div className="stage-display__meta">
            <div className="stage-display__headline">
              <span>{track.album || t("trackUnknownAlbum")}</span>
              {importedAt ? (
                <span>
                  {t("trackImportedLabel")}: {importedAt}
                </span>
              ) : null}
            </div>

            <SignalMeter audioRef={audioRef} isPlaying={isPlaying} t={t} />

            {track.lyricSource ? (
              <div className="stage-display__lyric-chip">
                {t("lyricsSourceLabel")}: {track.lyricSource}
              </div>
            ) : null}
          </div>

          <div className="stage-display__transport">
            <div className="transport-cluster">
              <button
                type="button"
                className="transport-button transport-button--secondary"
                onClick={onPrevious}
                disabled={!canPlayPrevious}
                aria-label={t("trackPrevious")}
              >
                <SkipBack size={20} strokeWidth={2.3} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="transport-button"
                onClick={() => void onTogglePlayback()}
                disabled={!canPlay}
                aria-label={isPlaying ? t("trackPause") : t("trackPlay")}
              >
                {isPlaying ? (
                  <Pause size={22} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <Play size={22} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="transport-button transport-button--secondary"
                onClick={onNext}
                disabled={!canPlayNext}
                aria-label={t("trackNext")}
              >
                <SkipForward size={20} strokeWidth={2.3} aria-hidden="true" />
              </button>
            </div>

            <div className="range-stack">
              <div className="range-stack__labels">
                <span>{formatDuration(displayedTime)}</span>
                <span>{formatDuration(totalDuration)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={rangeMax}
                step={0.1}
                value={displayedRangeValue}
                className="range-input"
                style={{ "--range-progress": `${progressValue * 100}%` } as CSSProperties}
                aria-label={t("lyricsTimelineLabel")}
                onPointerDown={(event) => {
                  isScrubbingRef.current = true;
                  setIsScrubbing(true);
                  previewSeek(Number(event.currentTarget.value));
                }}
                onInput={(event) => {
                  previewSeek(Number(event.currentTarget.value));
                }}
                onChange={(event) => {
                  const nextTime = Number(event.currentTarget.value);
                  previewSeek(nextTime);
                  if (!isScrubbingRef.current) {
                    commitSeek(nextTime);
                  }
                }}
                onPointerUp={(event) => commitSeek(Number(event.currentTarget.value))}
                onPointerCancel={(event) => commitSeek(Number(event.currentTarget.value))}
                onBlur={(event) => {
                  if (isScrubbing) {
                    commitSeek(Number(event.currentTarget.value));
                  }
                }}
              />
            </div>
          </div>

          <div className="playback-mode-row" aria-label={t("nowPlayingTitle")}>
            <button
              type="button"
              className={[
                "mode-chip",
                playbackOrderMode === "shuffle" ? "mode-chip--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={onTogglePlaybackOrderMode}
              aria-pressed={playbackOrderMode === "shuffle"}
              aria-label={
                playbackOrderMode === "shuffle"
                  ? t("playbackOrderShuffle")
                  : t("playbackOrderNormal")
              }
            >
              <Shuffle size={16} strokeWidth={2.2} aria-hidden="true" />
              <span>
                {playbackOrderMode === "shuffle"
                  ? t("playbackOrderShuffle")
                  : t("playbackOrderNormal")}
              </span>
            </button>

            <button
              type="button"
              className={[
                "mode-chip",
                repeatMode !== "off" ? "mode-chip--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={onCycleRepeatMode}
              aria-pressed={repeatMode !== "off"}
              aria-label={repeatLabel}
            >
              <RepeatIcon size={16} strokeWidth={2.2} aria-hidden="true" />
              <span>{repeatLabel}</span>
            </button>
          </div>

          <label className="volume-row">
            <span className="volume-row__label">
              <Volume2 size={17} strokeWidth={2.2} aria-hidden="true" />
              {t("volumeLabel")}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              className="range-input range-input--compact"
              style={{ "--range-progress": `${volume * 100}%` } as CSSProperties}
              aria-label={t("volumeLabel")}
              onChange={(event) => onVolumeChange(Number(event.currentTarget.value))}
            />
            <span className="volume-row__value">{Math.round(volume * 100)}%</span>
          </label>

          {!canPlay ? <p className="inline-error">{t("noAudioSource")}</p> : null}
          {error ? <p className="inline-error">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
