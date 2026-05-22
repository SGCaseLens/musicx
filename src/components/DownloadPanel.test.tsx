import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DownloadPanel } from "./DownloadPanel";
import type { TranslateFn } from "../i18n";

const t: TranslateFn = (key) => {
  const labels: Partial<Record<Parameters<TranslateFn>[0], string>> = {
    contextDownloadsTab: "Downloads",
    youtubeProgressHeading: "Download progress",
    downloadPhaseQueued: "Queued",
    downloadPhaseSearching: "Preparing",
    downloadPhaseDownloading: "Downloading",
    downloadPhaseConverting: "Converting",
    downloadPhaseWriting: "Saving",
    downloadPhaseDone: "Done",
    downloadPhaseError: "Failed",
    downloadRetryAction: "Retry download",
    downloadsEmptyTitle: "No active downloads",
    downloadsEmptyDescription: "Search a video",
  };
  return labels[key] ?? key;
};

describe("DownloadPanel", () => {
  it("offers an explicit retry action after a failed download", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <DownloadPanel
        progress={{
          videoId: "video-1",
          title: "Retry Song",
          phase: "error",
          progress: 100,
          message: "HTTP Error 429",
        }}
        status={null}
        onRetry={onRetry}
        t={t}
      />,
    );

    expect(screen.getByText("HTTP Error 429")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry download" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
