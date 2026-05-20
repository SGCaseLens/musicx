import { ArrowDownToLine, Search, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { formatDuration } from "../lib/format";
import type { TranslateFn } from "../i18n";
import type { Notice, Track, YouTubeVideo } from "../types";

function isComposingInputEvent(event: Event): boolean {
  return "isComposing" in event && Boolean((event as InputEvent).isComposing);
}

interface YouTubePanelProps {
  query: string;
  results: YouTubeVideo[];
  selectedTrack: Track | null;
  searching: boolean;
  downloadingVideoId: string | null;
  status: Notice | null;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onSearch: (query: string) => void | Promise<void>;
  onDownload: (video: YouTubeVideo) => void | Promise<void>;
  onActivate: (video: YouTubeVideo) => void | Promise<void>;
  onUseCurrentTrack: () => void;
  t: TranslateFn;
}

export function YouTubePanel({
  query,
  results,
  selectedTrack,
  searching,
  downloadingVideoId,
  status,
  searchInputRef,
  onQueryChange,
  onSearch,
  onDownload,
  onActivate,
  onUseCurrentTrack,
  t,
}: YouTubePanelProps) {
  const internalSearchInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingQueryRef = useRef(false);
  const [draftQuery, setDraftQuery] = useState(query);

  useEffect(() => {
    if (isComposingQueryRef.current) {
      return;
    }

    setDraftQuery(query);
    const input = internalSearchInputRef.current;
    if (input && input.value !== query) {
      input.value = query;
    }
  }, [query]);

  const setSearchInputNode = (node: HTMLInputElement | null) => {
    internalSearchInputRef.current = node;
    if (searchInputRef) {
      searchInputRef.current = node;
    }
  };

  const commitQuery = (value: string) => {
    setDraftQuery(value);
    onQueryChange(value);
  };

  return (
    <section className="context-card">
      <header className="context-card__header">
        <div>
          <p className="context-card__eyebrow">{t("youtubeTitle")}</p>
          <h2 className="context-card__title">{t("youtubeDescription")}</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={onUseCurrentTrack}
          disabled={!selectedTrack}
        >
          <WandSparkles size={15} strokeWidth={2.2} aria-hidden="true" />
          {t("youtubeUseCurrentTrack")}
        </button>
      </header>

      <form
        className="youtube-search"
        onSubmit={(event) => {
          event.preventDefault();
          const nextQuery = (internalSearchInputRef.current?.value ?? draftQuery).trim();
          onQueryChange(nextQuery);
          void onSearch(nextQuery);
        }}
      >
        <label className="youtube-search__field">
          <Search size={16} strokeWidth={2.1} aria-hidden="true" />
          <input
            ref={setSearchInputNode}
            defaultValue={query}
            aria-label={t("youtubeSearchPlaceholder")}
            placeholder={t("youtubeSearchPlaceholder")}
            className="text-input"
            onCompositionStart={() => {
              isComposingQueryRef.current = true;
            }}
            onCompositionEnd={(event) => {
              isComposingQueryRef.current = false;
              commitQuery(event.currentTarget.value);
            }}
            onChange={(event) => {
              if (
                isComposingQueryRef.current ||
                isComposingInputEvent(event.nativeEvent)
              ) {
                return;
              }

              commitQuery(event.currentTarget.value);
            }}
          />
        </label>
        <button type="submit" className="primary-button" disabled={!draftQuery.trim() || searching}>
          {searching ? t("youtubeSearching") : t("youtubeSearchAction")}
        </button>
      </form>

      {status ? (
        <div className={["context-message", `context-message--${status.tone}`].join(" ")}>
          {status.text}
        </div>
      ) : null}

      {results.length ? (
        <ul className="youtube-results" role="list">
          {results.map((video) => {
            const isDownloading = downloadingVideoId === video.id;

            return (
              <li
                key={video.id}
                className={[
                  "youtube-card",
                  downloadingVideoId ? "youtube-card--busy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  className="youtube-card__main"
                  disabled={Boolean(downloadingVideoId)}
                  aria-label={video.title}
                  onDoubleClick={() => {
                    if (!downloadingVideoId) {
                      void onActivate(video);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (downloadingVideoId || !["Enter", " "].includes(event.key)) {
                      return;
                    }

                    event.preventDefault();
                    void onActivate(video);
                  }}
                >
                  <div className="youtube-card__thumb">
                    {video.thumbnailUrl ? (
                      <img src={video.thumbnailUrl} alt="" />
                    ) : (
                      <span>{video.title.slice(0, 2).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="youtube-card__copy">
                    <strong title={video.title}>{video.title}</strong>
                    <span title={video.channel}>{video.channel}</span>
                    {video.description ? (
                      <span className="youtube-card__description" title={video.description}>
                        {video.description}
                      </span>
                    ) : null}
                    <span>{formatDuration(video.durationSec)}</span>
                  </div>
                </button>
                <div className="youtube-card__actions">
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`${t("youtubeDownloadAction")}: ${video.title}`}
                    onClick={() => {
                      void onDownload(video);
                    }}
                    disabled={Boolean(downloadingVideoId)}
                  >
                    <ArrowDownToLine size={15} strokeWidth={2.2} aria-hidden="true" />
                    {isDownloading ? t("youtubeDownloading") : t("youtubeDownloadAction")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty-state empty-state--context">
          <h3>{t("youtubeEmptyTitle")}</h3>
          <p>{t("youtubeEmptyDescription")}</p>
        </div>
      )}
    </section>
  );
}
