import { Disc3, Pause, Play, Trash2 } from "lucide-react";

import {
  formatDuration,
  formatTimestamp,
  formatTrackMeta,
  sourceAccent,
  trackSourceLabel,
} from "../lib/format";
import { resolveMediaUrl } from "../lib/tauri";
import type { TranslateFn } from "../i18n";
import type { Locale, Track } from "../types";

interface TrackListProps {
  tracks: Track[];
  selectedTrackId: string | null;
  currentTrackId: string | null;
  isPlaying: boolean;
  locale: Locale;
  deletingTrackId?: string | null;
  onSelect: (trackId: string) => void;
  onPlay: (track: Track) => void;
  onDelete: (track: Track) => void;
  t: TranslateFn;
}

export function TrackList({
  tracks,
  selectedTrackId,
  currentTrackId,
  isPlaying,
  locale,
  deletingTrackId,
  onSelect,
  onPlay,
  onDelete,
  t,
}: TrackListProps) {
  if (!tracks.length) {
    return (
      <div className="empty-state">
        <h3>{t("libraryEmptyTitle")}</h3>
        <p>{t("libraryEmptyDescription")}</p>
      </div>
    );
  }

  return (
    <ul className="track-list" role="list">
      {tracks.map((track) => {
        const isSelected = track.id === selectedTrackId;
        const isCurrent = track.id === currentTrackId;
        const isCurrentPlaying = isCurrent && isPlaying;
        const trackMeta = formatTrackMeta(
          track,
          t("trackUnknownArtist"),
          t("trackUnknownAlbum"),
        );
        const artworkUrl =
          resolveMediaUrl(track.artworkPath) ?? resolveMediaUrl(track.artworkUrl);

        return (
          <li
            key={track.id}
            className={[
              "track-row",
              isSelected ? "track-row--selected" : "",
              isCurrent ? "track-row--current" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <button
              type="button"
              className="track-row__main"
              onClick={() => onSelect(track.id)}
            >
              <div className="track-row__art" aria-hidden="true">
                {artworkUrl ? (
                  <img src={artworkUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <Disc3 size={18} strokeWidth={2.2} />
                )}
              </div>
              <div className="track-row__copy">
                <strong className="track-row__title" title={track.title}>
                  {track.title}
                </strong>
                <span className="track-row__meta" title={trackMeta}>
                  {trackMeta}
                </span>
                {track.importedAt ? (
                  <span className="track-row__submeta">
                    {t("trackImportedLabel")}: {formatTimestamp(track.importedAt, locale)}
                  </span>
                ) : null}
                <div className="track-row__details">
                  <span className={["source-pill", sourceAccent(track.source)].join(" ")}>
                    {trackSourceLabel(track.source, locale)}
                  </span>
                  <span className="track-row__duration">
                    {formatDuration(track.durationSec) || t("trackDurationUnknown")}
                  </span>
                </div>
              </div>
            </button>
            <div className="track-row__actions">
              <button
                type="button"
                className="track-row__action"
                aria-label={isCurrentPlaying ? t("trackPause") : t("trackPlay")}
                onClick={() => onPlay(track)}
              >
                {isCurrentPlaying ? (
                  <Pause size={16} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <Play size={16} strokeWidth={2.5} fill="currentColor" aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="track-row__action track-row__action--danger"
                aria-label={t("trackDelete")}
                title={t("trackDelete")}
                onClick={() => onDelete(track)}
                disabled={Boolean(deletingTrackId)}
              >
                <Trash2 size={15} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
