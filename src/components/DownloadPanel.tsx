import type { CSSProperties } from "react";

import { Download, LoaderCircle } from "lucide-react";

import type { TranslateFn, TranslationKey } from "../i18n";
import type { DownloadProgress, Notice } from "../types";

interface DownloadPanelProps {
  progress: DownloadProgress | null;
  status: Notice | null;
  t: TranslateFn;
}

export function DownloadPanel({ progress, status, t }: DownloadPanelProps) {
  const progressLabelMap: Record<DownloadProgress["phase"], TranslationKey> = {
    queued: "downloadPhaseQueued",
    searching: "downloadPhaseSearching",
    downloading: "downloadPhaseDownloading",
    converting: "downloadPhaseConverting",
    writing: "downloadPhaseWriting",
    done: "downloadPhaseDone",
    error: "downloadPhaseError",
  };

  return (
    <section className="context-card">
      <header className="context-card__header">
        <div>
          <p className="context-card__eyebrow">{t("contextDownloadsTab")}</p>
          <h2 className="context-card__title">{t("youtubeProgressHeading")}</h2>
        </div>
      </header>

      {status ? (
        <div className={["context-message", `context-message--${status.tone}`].join(" ")}>
          {status.text}
        </div>
      ) : null}

      {progress ? (
        <div className="download-monitor">
          <div className="download-monitor__hero">
            <div className="download-monitor__icon">
              {progress.phase === "done" || progress.phase === "error" ? (
                <Download size={24} strokeWidth={2.1} aria-hidden="true" />
              ) : (
                <LoaderCircle
                  size={24}
                  strokeWidth={2.1}
                  aria-hidden="true"
                  className="download-monitor__spinner"
                />
              )}
            </div>
            <div className="download-monitor__copy">
              <strong>{progress.title || t("youtubeProgressHeading")}</strong>
              <span>{t(progressLabelMap[progress.phase])}</span>
            </div>
            <span className="download-monitor__percent">{Math.round(progress.progress)}%</span>
          </div>

          <div className="progress-bar progress-bar--large">
            <div
              className="progress-bar__fill"
              style={{ width: `${progress.progress}%` } as CSSProperties}
            />
          </div>

          {progress.message ? (
            <p className="download-monitor__message">{progress.message}</p>
          ) : null}
        </div>
      ) : (
        <div className="empty-state empty-state--context">
          <h3>{t("downloadsEmptyTitle")}</h3>
          <p>{t("downloadsEmptyDescription")}</p>
        </div>
      )}
    </section>
  );
}
