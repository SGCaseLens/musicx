import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  ArrowDownToLine,
  Disc3,
  Download,
  Eraser,
  ListMusic,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Search,
  SortAsc,
  SortDesc,
  Star,
  TextQuote,
  Trash2,
  X,
} from "lucide-react";

import { DownloadPanel } from "./components/DownloadPanel";
import { LyricsPanel } from "./components/LyricsPanel";
import { NowPlayingCard } from "./components/NowPlayingCard";
import { TrackList } from "./components/TrackList";
import { YouTubePanel } from "./components/YouTubePanel";
import { useAudioPlayer } from "./hooks/useAudioPlayer";
import { useArtworkAccent } from "./hooks/useArtworkAccent";
import { createTranslator, getPreferredLocale, localeOptions } from "./i18n";
import {
  clamp,
  filterTracks,
  mergeTrackCollections,
  toErrorMessage,
  toneFromError,
} from "./lib/format";
import {
  addTrackToQueue,
  materializeQueue,
  removeTrackFromQueue,
  sortLibraryTracks,
} from "./lib/library";
import {
  bootstrapApp,
  deleteTrack,
  downloadYoutubeAudio,
  getSystemOutputVolume,
  getRuntimeMode,
  importLocalTracks,
  listTracks,
  openSavedLibrary,
  resolveMediaUrl,
  searchLyricsForTrack,
  searchYoutubeVideos,
  setSystemOutputVolume,
  subscribeToDownloadProgress,
  recordTrackPlayed,
  updateTrackLyricsOffset,
  updateTrackFavorite,
} from "./lib/tauri";
import type {
  BootstrapResult,
  DownloadProgress,
  LibraryFilter,
  LibrarySortMode,
  Locale,
  Notice,
  PlaybackOrderMode,
  RepeatMode,
  SortDirection,
  Track,
  YouTubeVideo,
} from "./types";
import "./App.css";

type ContextTab = "lyrics" | "youtube" | "downloads";
type TrackMenuState = {
  trackId: string;
  x: number;
  y: number;
} | null;

const SYSTEM_VOLUME_SYNC_INTERVAL_MS = 1_250;
const SYSTEM_VOLUME_LOCAL_SETTLE_MS = 700;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const QUEUE_STORAGE_KEY = "musicx.queueTrackIds.v1";
const SORT_STORAGE_KEY = "musicx.librarySort.v1";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function isRetriableDownloadError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return [
    "429",
    "too many requests",
    "timed out",
    "timeout",
    "network",
    "connection",
    "temporarily",
    "unavailable",
    "reset",
    "failed to fetch",
    "http error",
    "could not complete",
  ].some((token) => message.includes(token));
}

function retryDelayMs(attempt: number): number {
  return 650 * attempt + 350;
}

function readStoredQueue(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(QUEUE_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed)
      ? parsed.filter((trackId): trackId is string => typeof trackId === "string")
      : [];
  } catch {
    return [];
  }
}

function readStoredSort(): { mode: LibrarySortMode; direction: SortDirection } {
  if (typeof window === "undefined") {
    return { mode: "added", direction: "desc" };
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SORT_STORAGE_KEY) ?? "{}") as {
      mode?: LibrarySortMode;
      direction?: SortDirection;
    };
    const mode: LibrarySortMode = ["added", "title", "artist", "duration", "lastPlayed"].includes(
      parsed.mode ?? "",
    )
      ? (parsed.mode as LibrarySortMode)
      : "added";
    const direction: SortDirection = parsed.direction === "asc" ? "asc" : "desc";
    return { mode, direction };
  } catch {
    return { mode: "added", direction: "desc" };
  }
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isComposingInputEvent(event: Event): boolean {
  return "isComposing" in event && Boolean((event as InputEvent).isComposing);
}

function isKeyboardActivation(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

function cycleRepeatMode(mode: RepeatMode): RepeatMode {
  if (mode === "off") {
    return "all";
  }

  if (mode === "all") {
    return "one";
  }

  return "off";
}

function pickRandomTrackId(trackIds: string[], currentTrackId: string | null): string | null {
  if (!trackIds.length) {
    return null;
  }

  if (trackIds.length === 1) {
    return trackIds[0] ?? null;
  }

  const candidates = currentTrackId
    ? trackIds.filter((trackId) => trackId !== currentTrackId)
    : trackIds;
  const safeCandidates = candidates.length ? candidates : trackIds;
  const nextIndex = Math.floor(Math.random() * safeCandidates.length);
  return safeCandidates[nextIndex] ?? null;
}

function App() {
  const runtimeMode = getRuntimeMode();
  const [locale, setLocale] = useState<Locale>(() => getPreferredLocale());
  const [bootstrapMeta, setBootstrapMeta] = useState<BootstrapResult | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [librarySort, setLibrarySort] = useState<LibrarySortMode>(() => readStoredSort().mode);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    () => readStoredSort().direction,
  );
  const [queueTrackIds, setQueueTrackIds] = useState<string[]>(() => readStoredQueue());
  const [trackMenu, setTrackMenu] = useState<TrackMenuState>(null);
  const [activeContextTab, setActiveContextTab] = useState<ContextTab>("lyrics");
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [playbackOrderMode, setPlaybackOrderMode] =
    useState<PlaybackOrderMode>("normal");
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("off");
  const [shuffleHistory, setShuffleHistory] = useState<string[]>([]);
  const [youtubeQuery, setYoutubeQuery] = useState("");
  const [youtubeResults, setYoutubeResults] = useState<YouTubeVideo[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lyricsNotice, setLyricsNotice] = useState<Notice | null>(null);
  const [youtubeNotice, setYoutubeNotice] = useState<Notice | null>(null);
  const [downloadNotice, setDownloadNotice] = useState<Notice | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isSearchingYoutube, setIsSearchingYoutube] = useState(false);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [lyricsError, setLyricsError] = useState<string>();
  const [deletingTrackId, setDeletingTrackId] = useState<string | null>(null);
  const [downloadingVideoId, setDownloadingVideoId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(
    null,
  );
  const [retryDownloadVideo, setRetryDownloadVideo] = useState<YouTubeVideo | null>(null);
  const [retryDownloadAutoplay, setRetryDownloadAutoplay] = useState(false);
  const autoplayNextSelectionRef = useRef(false);
  const sawDownloadProgressRef = useRef(false);
  const handledEndedCountRef = useRef(0);
  const youtubeSearchRequestRef = useRef(0);
  const activeDownloadVideoRef = useRef<string | null>(null);
  const youtubeSearchInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingLibraryQueryRef = useRef(false);
  const systemVolumeRequestRef = useRef(0);
  const systemVolumeTimerRef = useRef<number | null>(null);
  const systemVolumeSyncInFlightRef = useRef(false);
  const systemVolumePendingRequestRef = useRef<number | null>(null);
  const systemVolumeLocalChangeAtRef = useRef(0);
  const viewportSyncFrameRef = useRef<number | null>(null);
  const autoLyricsTrackIdsRef = useRef<Set<string>>(new Set());
  const lastRecordedPlayTrackRef = useRef<string | null>(null);

  const t = createTranslator(locale);
  const deferredQuery = useDeferredValue(libraryQuery);
  const searchableTracks = filterTracks(tracks, deferredQuery);
  const filteredTracks = searchableTracks.filter((track) => {
    switch (libraryFilter) {
      case "favorites":
        return Boolean(track.isFavorite);
      case "recent":
        return Boolean(track.lastPlayedAt);
      case "local":
      case "youtube":
        return track.source === libraryFilter;
      case "all":
      default:
        return true;
    }
  });
  const visibleTracks = sortLibraryTracks(filteredTracks, librarySort, sortDirection);
  const queueTracks = materializeQueue(queueTrackIds, tracks);
  const queuedTrackIdSet = new Set(queueTrackIds);
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? null;
  const playbackQueue =
    queueTracks.length && selectedTrack
      ? selectedTrack && queueTrackIds.includes(selectedTrack.id)
        ? queueTracks
        : [selectedTrack, ...queueTracks]
      : selectedTrackId && visibleTracks.some((track) => track.id === selectedTrackId)
        ? visibleTracks
        : tracks;
  const playbackQueueIds = playbackQueue.map((track) => track.id);
  const selectedQueueIndex = selectedTrackId
    ? playbackQueueIds.indexOf(selectedTrackId)
    : -1;
  const audioSource = resolveMediaUrl(selectedTrack?.audioPath ?? selectedTrack?.filePath);
  const artworkUrl =
    resolveMediaUrl(selectedTrack?.artworkPath) ??
    resolveMediaUrl(selectedTrack?.artworkUrl);
  const artworkPalette = useArtworkAccent(artworkUrl);
  const lyricsCount = tracks.filter((track) => track.lyrics?.length).length;
  const activeDownloads =
    downloadProgress &&
    downloadProgress.phase !== "done" &&
    downloadProgress.phase !== "error"
      ? 1
      : 0;
  const localTracksCount = tracks.filter((track) => track.source === "local").length;
  const youtubeTracksCount = tracks.filter((track) => track.source === "youtube").length;
  const favoriteTracksCount = tracks.filter((track) => track.isFavorite).length;
  const recentTracksCount = tracks.filter((track) => track.lastPlayedAt).length;
  const runtimeHint =
    runtimeMode === "desktop" ? t("runtimeDesktopHint") : t("runtimeBrowserHint");
  const controlsSystemVolume = runtimeMode === "desktop";
  const stageStyle = {
    "--accent": artworkPalette.accent,
    "--accent-strong": artworkPalette.accentStrong,
    "--accent-soft": artworkPalette.accentSoft,
    "--accent-glow": artworkPalette.accentGlow,
  } as CSSProperties;

  const canPlayPrevious =
    playbackOrderMode === "shuffle"
      ? shuffleHistory.length > 0
      : selectedQueueIndex > 0 || (repeatMode === "all" && playbackQueueIds.length > 1);
  const canPlayNext =
    playbackOrderMode === "shuffle"
      ? playbackQueueIds.length > 1 || (repeatMode !== "off" && playbackQueueIds.length === 1)
      : selectedQueueIndex > -1 &&
        (selectedQueueIndex < playbackQueueIds.length - 1 ||
          (repeatMode === "all" && playbackQueueIds.length > 1));

  const { audioRef, endedCount, playback, play, seek, setVolume, togglePlayback } =
    useAudioPlayer(selectedTrack, audioSource, {
      volumeMode: controlsSystemVolume ? "system" : "element",
    });

  const syncSystemOutputVolume = useEffectEvent(async () => {
    if (!controlsSystemVolume) {
      return;
    }

    const isLocalChangeSettling =
      systemVolumeTimerRef.current !== null ||
      systemVolumePendingRequestRef.current !== null ||
      Date.now() - systemVolumeLocalChangeAtRef.current < SYSTEM_VOLUME_LOCAL_SETTLE_MS;
    if (isLocalChangeSettling || systemVolumeSyncInFlightRef.current) {
      return;
    }

    systemVolumeSyncInFlightRef.current = true;
    const requestSnapshot = systemVolumeRequestRef.current;
    try {
      const systemVolume = await getSystemOutputVolume();
      if (
        systemVolume !== null &&
        requestSnapshot === systemVolumeRequestRef.current &&
        Math.abs(playback.volume - systemVolume) >= 0.005
      ) {
        setVolume(systemVolume);
      }
    } catch (error) {
      console.warn("Couldn't read macOS system volume", error);
    } finally {
      systemVolumeSyncInFlightRef.current = false;
    }
  });

  const commitSystemOutputVolume = useEffectEvent(async (volume: number, requestId: number) => {
    systemVolumePendingRequestRef.current = requestId;
    try {
      const confirmedVolume = await setSystemOutputVolume(volume);
      if (requestId === systemVolumeRequestRef.current) {
        setVolume(confirmedVolume);
      }
    } catch (error) {
      if (requestId !== systemVolumeRequestRef.current) {
        return;
      }

      const nextNotice = {
        tone: "danger" as const,
        text: `${t("statusSystemVolumeError")}: ${toErrorMessage(error)}`,
      };
      setNotice(nextNotice);
    } finally {
      if (systemVolumePendingRequestRef.current === requestId) {
        systemVolumePendingRequestRef.current = null;
      }
    }
  });

  const handleVolumeChange = useEffectEvent(
    (nextVolume: number, options: { immediate?: boolean } = {}) => {
      const safeVolume = clamp(nextVolume, 0, 1);
      systemVolumeLocalChangeAtRef.current = Date.now();
      setVolume(safeVolume);

      if (!controlsSystemVolume) {
        return;
      }

      systemVolumeRequestRef.current += 1;
      const requestId = systemVolumeRequestRef.current;
      if (systemVolumeTimerRef.current !== null) {
        window.clearTimeout(systemVolumeTimerRef.current);
        systemVolumeTimerRef.current = null;
      }

      const commit = () => {
        systemVolumeTimerRef.current = null;
        void commitSystemOutputVolume(safeVolume, requestId);
      };

      if (options.immediate) {
        commit();
        return;
      }

      systemVolumeTimerRef.current = window.setTimeout(commit, 80);
    },
  );

  const syncViewportMetrics = useEffectEvent(() => {
    const viewport = window.visualViewport;
    const width = Math.max(1, Math.round(viewport?.width ?? window.innerWidth));
    const height = Math.max(1, Math.round(viewport?.height ?? window.innerHeight));

    document.documentElement.style.setProperty("--app-viewport-width", `${width}px`);
    document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
  });

  const refreshLibrary = useEffectEvent(async (withNotice = false) => {
    try {
      const nextTracks = await listTracks();
      setTracks((current) =>
        nextTracks.length ? mergeTrackCollections(current, nextTracks) : nextTracks,
      );

      if (withNotice) {
        setNotice({ tone: "neutral", text: t("statusTracksRefreshed") });
      }
    } catch (error) {
      if (withNotice) {
        setNotice({
          tone: toneFromError(error),
          text: `${t("statusTracksRefreshError")}: ${toErrorMessage(error)}`,
        });
      }
    }
  });

  const handleOpenSavedLibrary = useEffectEvent(async () => {
    try {
      await openSavedLibrary();
    } catch (error) {
      setNotice({
        tone: toneFromError(error),
        text: `${t("statusLibraryOpenError")}: ${toErrorMessage(error)}`,
      });
    }
  });

  const bootstrapAppState = useEffectEvent(async () => {
    setIsBootstrapping(true);
    const fallbackLocale = getPreferredLocale();
    const fallbackTranslator = createTranslator(fallbackLocale);
    let nextLocale = fallbackLocale;
    let bootstrapTracks: Track[] = [];
    let bootstrapped = false;
    let bootstrapError: unknown;

    try {
      const initialTracks = await listTracks();
      if (initialTracks.length) {
        setTracks(initialTracks);
        setNotice({
          tone: "neutral",
          text: fallbackTranslator("statusReady"),
        });
      }
    } catch (error) {
      setNotice({
        tone: "danger",
        text: `${fallbackTranslator("statusTracksRefreshError")}: ${toErrorMessage(error)}`,
      });
    }

    try {
      const bootstrap = await bootstrapApp();
      nextLocale = bootstrap.locale ?? fallbackLocale;

      setLocale(nextLocale);
      setBootstrapMeta(bootstrap);
      bootstrapTracks = bootstrap.tracks;
      bootstrapped = true;
    } catch (error) {
      bootstrapError = error;
      setBootstrapMeta(null);
    } finally {
      try {
        const listedTracks = await listTracks();
        const nextTracks = listedTracks.length
          ? mergeTrackCollections(bootstrapTracks, listedTracks)
          : bootstrapTracks;

        setTracks(nextTracks);

        const translator = createTranslator(nextLocale);
        setNotice({
          tone: bootstrapped ? "neutral" : "success",
          text: translator("statusReady"),
        });
      } catch (error) {
        if (bootstrapTracks.length) {
          setTracks(bootstrapTracks);
          setNotice({
            tone: bootstrapError ? "danger" : "neutral",
            text: bootstrapError
              ? `${fallbackTranslator("statusBootstrapError")}: ${toErrorMessage(bootstrapError)}`
              : fallbackTranslator("statusReady"),
          });
        } else {
          const primaryError = bootstrapError ?? error;
          setNotice({
            tone: "danger",
            text: `${fallbackTranslator("statusBootstrapError")}: ${toErrorMessage(primaryError)}`,
          });
        }
      }

      setIsBootstrapping(false);
    }
  });

  const handleDownloadProgress = useEffectEvent((progress: DownloadProgress) => {
    sawDownloadProgressRef.current = true;
    setDownloadProgress(progress);
    setActiveContextTab("downloads");

    if (progress.track) {
      setTracks((current) => [
        progress.track as Track,
        ...current.filter((track) => track.id !== progress.track?.id),
      ]);
    }

    if (progress.phase === "error") {
      const nextNotice = {
        tone: "danger" as const,
        text: `${t("statusDownloadError")}: ${progress.message ?? ""}`.trim(),
      };
      setDownloadNotice(nextNotice);
      setNotice(nextNotice);
    }

    if (progress.phase === "done") {
      const nextNotice = {
        tone: "success" as const,
        text: t("statusDownloadComplete", {
          title: progress.title ?? "track",
        }),
      };
      activeDownloadVideoRef.current = null;
      setDownloadingVideoId(null);
      setRetryDownloadVideo(null);
      setRetryDownloadAutoplay(false);
      setDownloadNotice(nextNotice);
      setNotice(nextNotice);
      void refreshLibrary(false);
    }
  });

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const scheduleSync = () => {
      if (viewportSyncFrameRef.current !== null) {
        return;
      }

      viewportSyncFrameRef.current = window.requestAnimationFrame(() => {
        viewportSyncFrameRef.current = null;
        syncViewportMetrics();
      });
    };

    syncViewportMetrics();
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("focus", scheduleSync);
    window.addEventListener("pageshow", scheduleSync);
    window.addEventListener("orientationchange", scheduleSync);
    document.addEventListener("visibilitychange", scheduleSync);
    window.visualViewport?.addEventListener("resize", scheduleSync);
    window.visualViewport?.addEventListener("scroll", scheduleSync);

    return () => {
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("focus", scheduleSync);
      window.removeEventListener("pageshow", scheduleSync);
      window.removeEventListener("orientationchange", scheduleSync);
      document.removeEventListener("visibilitychange", scheduleSync);
      window.visualViewport?.removeEventListener("resize", scheduleSync);
      window.visualViewport?.removeEventListener("scroll", scheduleSync);
      if (viewportSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportSyncFrameRef.current);
        viewportSyncFrameRef.current = null;
      }
      document.documentElement.style.removeProperty("--app-viewport-width");
      document.documentElement.style.removeProperty("--app-viewport-height");
    };
  }, []);

  useEffect(() => {
    if (!controlsSystemVolume) {
      return;
    }

    const syncNow = () => {
      void syncSystemOutputVolume();
    };
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        syncNow();
      }
    };
    const intervalId = window.setInterval(syncNow, SYSTEM_VOLUME_SYNC_INTERVAL_MS);

    syncNow();
    window.addEventListener("focus", syncNow);
    window.addEventListener("pageshow", syncNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", syncNow);
      window.removeEventListener("pageshow", syncNow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [controlsSystemVolume]);

  useEffect(() => {
    return () => {
      if (systemVolumeTimerRef.current !== null) {
        window.clearTimeout(systemVolumeTimerRef.current);
        systemVolumeTimerRef.current = null;
      }
      systemVolumePendingRequestRef.current = null;
      systemVolumeSyncInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNotice(null);
    }, 4200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [notice]);

  useEffect(() => {
    if (!isLibraryOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsLibraryOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLibraryOpen]);

  useEffect(() => {
    void bootstrapAppState();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void subscribeToDownloadProgress(handleDownloadProgress).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (!tracks.length) {
      setSelectedTrackId(null);
      return;
    }

    if (!selectedTrackId || !tracks.some((track) => track.id === selectedTrackId)) {
      setSelectedTrackId(tracks[0].id);
    }
  }, [tracks, selectedTrackId]);

  useEffect(() => {
    const validTrackIds = new Set(tracks.map((track) => track.id));
    setQueueTrackIds((current) =>
      current.filter((trackId, index) => validTrackIds.has(trackId) && current.indexOf(trackId) === index),
    );
  }, [tracks]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queueTrackIds));
  }, [queueTrackIds]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      SORT_STORAGE_KEY,
      JSON.stringify({ mode: librarySort, direction: sortDirection }),
    );
  }, [librarySort, sortDirection]);

  useEffect(() => {
    if (!selectedTrackId) {
      return;
    }

    setQueueTrackIds((current) => removeTrackFromQueue(current, selectedTrackId));
  }, [selectedTrackId]);

  useEffect(() => {
    setLyricsError(undefined);
    setLyricsNotice(null);
  }, [selectedTrackId]);

  useEffect(() => {
    if (!trackMenu) {
      return;
    }

    const closeMenu = () => setTrackMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [trackMenu]);

  const autoSearchMissingLyrics = useEffectEvent(async (track: Track) => {
    try {
      const lyrics = await searchLyricsForTrack(track);
      if (!lyrics?.length) {
        return;
      }

      startTransition(() => {
        setTracks((current) =>
          current.map((item) =>
            item.id === track.id
              ? {
                  ...item,
                  lyrics,
                  lyricSource: "search_lyrics_for_track",
                }
              : item,
          ),
        );
      });
      setLyricsNotice({
        tone: "success",
        text: t("statusLyricsSuccess", { title: track.title }),
      });
    } catch (error) {
      console.warn("Couldn't auto-load lyrics", error);
    }
  });

  const handleLyricOffsetChange = useEffectEvent(
    async (trackId: string, nextOffsetMs: number) => {
      const safeOffsetMs = clamp(Math.round(nextOffsetMs), -30_000, 30_000);
      let previousOffsetMs = 0;

      setTracks((current) =>
        current.map((track) => {
          if (track.id !== trackId) {
            return track;
          }

          previousOffsetMs = track.lyricOffsetMs ?? 0;
          return {
            ...track,
            lyricOffsetMs: safeOffsetMs,
          };
        }),
      );

      try {
        const updatedTrack = await updateTrackLyricsOffset(trackId, safeOffsetMs);
        if (updatedTrack) {
          setTracks((current) =>
            current.map((track) =>
              track.id === trackId
                ? {
                    ...track,
                    lyricOffsetMs: updatedTrack.lyricOffsetMs ?? safeOffsetMs,
                    lyrics: updatedTrack.lyrics ?? track.lyrics,
                    lyricSource: updatedTrack.lyricSource ?? track.lyricSource,
                  }
                : track,
            ),
          );
        }
      } catch (error) {
        setTracks((current) =>
          current.map((track) =>
            track.id === trackId
              ? {
                  ...track,
                  lyricOffsetMs: previousOffsetMs,
                }
              : track,
          ),
        );
        const nextNotice = {
          tone: toneFromError(error),
          text: `${t("statusLyricsOffsetError")}: ${toErrorMessage(error)}`,
        };
        setLyricsNotice(nextNotice);
        setNotice(nextNotice);
      }
    },
  );

  useEffect(() => {
    if (
      !selectedTrack ||
      selectedTrack.source !== "youtube" ||
      selectedTrack.lyrics?.length ||
      autoLyricsTrackIdsRef.current.has(selectedTrack.id)
    ) {
      return;
    }

    autoLyricsTrackIdsRef.current.add(selectedTrack.id);
    void autoSearchMissingLyrics(selectedTrack);
  }, [selectedTrack?.id, selectedTrack?.source, selectedTrack?.lyrics?.length]);

  useEffect(() => {
    if (!selectedTrack || !autoplayNextSelectionRef.current) {
      return;
    }

    autoplayNextSelectionRef.current = false;
    void play();
  }, [selectedTrack?.id]);

  const recordPlaybackStart = useEffectEvent(async (track: Track) => {
    try {
      const updatedTrack = await recordTrackPlayed(track.id);
      const playedAt = updatedTrack?.lastPlayedAt ?? new Date().toISOString();
      setTracks((current) =>
        current.map((item) =>
          item.id === track.id
            ? {
                ...item,
                playCount: updatedTrack?.playCount ?? (item.playCount ?? 0) + 1,
                lastPlayedAt: playedAt,
                isFavorite: updatedTrack?.isFavorite ?? item.isFavorite,
              }
            : item,
        ),
      );
    } catch (error) {
      console.warn("Couldn't record recently played track", error);
    }
  });

  useEffect(() => {
    if (!selectedTrack || !playback.isPlaying) {
      return;
    }

    if (lastRecordedPlayTrackRef.current === selectedTrack.id) {
      return;
    }

    lastRecordedPlayTrackRef.current = selectedTrack.id;
    void recordPlaybackStart(selectedTrack);
  }, [playback.isPlaying, selectedTrack?.id]);

  useEffect(() => {
    if (selectedTrackId !== lastRecordedPlayTrackRef.current) {
      lastRecordedPlayTrackRef.current = null;
    }
  }, [selectedTrackId]);

  useEffect(() => {
    setShuffleHistory((current) =>
      current.filter((trackId) => tracks.some((track) => track.id === trackId)),
    );
  }, [tracks]);

  useEffect(() => {
    if (playbackOrderMode === "normal" && shuffleHistory.length) {
      setShuffleHistory([]);
    }
  }, [playbackOrderMode, shuffleHistory.length]);

  const selectTrack = useEffectEvent(
    (
      trackId: string,
      options?: {
        autoplay?: boolean;
        focusLyrics?: boolean;
        resetShuffleHistory?: boolean;
      },
    ) => {
      if (options?.autoplay) {
        autoplayNextSelectionRef.current = true;
      }

      if (options?.resetShuffleHistory) {
        setShuffleHistory([]);
      }

      setSelectedTrackId(trackId);

      if (options?.focusLyrics) {
        setActiveContextTab("lyrics");
      }
    },
  );

  const openTrackMenu = useEffectEvent((track: Track, x: number, y: number) => {
    const menuWidth = 236;
    const menuHeight = 280;
    setTrackMenu({
      trackId: track.id,
      x: Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12)),
    });
  });

  const handleAddToQueue = useEffectEvent(
    (track: Track, placement: "next" | "end" = "end") => {
      setQueueTrackIds((current) => addTrackToQueue(current, track.id, placement));
      setNotice({
        tone: "success",
        text: t(placement === "next" ? "statusQueueNext" : "statusQueueAdded", {
          title: track.title,
        }),
      });
      setTrackMenu(null);
    },
  );

  const handleRemoveFromQueue = useEffectEvent((track: Track) => {
    setQueueTrackIds((current) => removeTrackFromQueue(current, track.id));
    setNotice({
      tone: "neutral",
      text: t("statusQueueRemoved", { title: track.title }),
    });
    setTrackMenu(null);
  });

  const handleClearQueue = useEffectEvent(() => {
    setQueueTrackIds([]);
    setNotice({ tone: "neutral", text: t("statusQueueCleared") });
  });

  const handleToggleFavorite = useEffectEvent(async (track: Track) => {
    const nextFavorite = !track.isFavorite;
    setTracks((current) =>
      current.map((item) =>
        item.id === track.id
          ? {
              ...item,
              isFavorite: nextFavorite,
            }
          : item,
      ),
    );
    setTrackMenu(null);

    try {
      const updatedTrack = await updateTrackFavorite(track.id, nextFavorite);
      if (updatedTrack) {
        setTracks((current) =>
          current.map((item) =>
            item.id === track.id
              ? {
                  ...item,
                  isFavorite: updatedTrack.isFavorite,
                  playCount: updatedTrack.playCount ?? item.playCount,
                  lastPlayedAt: updatedTrack.lastPlayedAt ?? item.lastPlayedAt,
                }
              : item,
          ),
        );
      }
      setNotice({
        tone: "success",
        text: t(nextFavorite ? "statusFavoriteAdded" : "statusFavoriteRemoved", {
          title: track.title,
        }),
      });
    } catch (error) {
      setTracks((current) =>
        current.map((item) =>
          item.id === track.id
            ? {
                ...item,
                isFavorite: track.isFavorite,
              }
            : item,
        ),
      );
      setNotice({
        tone: toneFromError(error),
        text: `${t("statusFavoriteError")}: ${toErrorMessage(error)}`,
      });
    }
  });

  const handlePreviousTrack = useEffectEvent(() => {
    if (!selectedTrackId || !playbackQueueIds.length) {
      return;
    }

    if (playbackOrderMode === "shuffle") {
      setShuffleHistory((current) => {
        const previousTrackId = current[current.length - 1];
        if (!previousTrackId) {
          return current;
        }

        autoplayNextSelectionRef.current = true;
        setSelectedTrackId(previousTrackId);
        return current.slice(0, -1);
      });
      return;
    }

    if (selectedQueueIndex < 0) {
      return;
    }

    const previousIndex =
      selectedQueueIndex > 0
        ? selectedQueueIndex - 1
        : repeatMode === "all" && playbackQueueIds.length > 1
          ? playbackQueueIds.length - 1
          : -1;
    const previousTrackId =
      previousIndex >= 0 ? playbackQueueIds[previousIndex] : null;

    if (!previousTrackId) {
      return;
    }

    selectTrack(previousTrackId, { autoplay: true });
  });

  const handleNextTrack = useEffectEvent(() => {
    if (!playbackQueueIds.length) {
      return;
    }

    if (playbackOrderMode === "shuffle") {
      const nextTrackId = pickRandomTrackId(playbackQueueIds, selectedTrackId);
      if (!nextTrackId || nextTrackId === selectedTrackId) {
        if (nextTrackId && repeatMode !== "off") {
          seek(0);
          void play();
        }
        return;
      }

      setShuffleHistory((current) =>
        selectedTrackId ? [...current, selectedTrackId].slice(-24) : current,
      );
      selectTrack(nextTrackId, { autoplay: true });
      return;
    }

    if (selectedQueueIndex < 0) {
      const firstTrackId = playbackQueueIds[0];
      if (firstTrackId) {
        selectTrack(firstTrackId, { autoplay: true });
      }
      return;
    }

    const nextIndex =
      selectedQueueIndex < playbackQueueIds.length - 1
        ? selectedQueueIndex + 1
        : repeatMode === "all" && playbackQueueIds.length > 1
          ? 0
          : -1;
    const nextTrackId = nextIndex >= 0 ? playbackQueueIds[nextIndex] : null;

    if (!nextTrackId) {
      return;
    }

    selectTrack(nextTrackId, { autoplay: true });
  });

  const focusYoutubeSearch = useEffectEvent(() => {
    setIsLibraryOpen(false);
    setActiveContextTab("youtube");

    window.requestAnimationFrame(() => {
      const input = youtubeSearchInputRef.current;
      input?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      input?.focus();
      input?.select();
    });
  });

  const handleKeyboardShortcut = useEffectEvent((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const isCommandShortcut = event.metaKey && !event.ctrlKey && !event.altKey;

    if (isCommandShortcut && key === "o") {
      event.preventDefault();
      setIsLibraryOpen(true);
      return;
    }

    if (isCommandShortcut && key === "r") {
      event.preventDefault();
      void refreshLibrary(true);
      return;
    }

    if (isCommandShortcut && key === "s") {
      event.preventDefault();
      focusYoutubeSearch();
      return;
    }

    if (isCommandShortcut && key === "n") {
      event.preventDefault();
      handleNextTrack();
      return;
    }

    if (isCommandShortcut && key === "p") {
      event.preventDefault();
      handlePreviousTrack();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey || isEditableKeyboardTarget(event.target)) {
      return;
    }

    switch (event.key) {
      case " ":
      case "Spacebar":
        event.preventDefault();
        void togglePlayback();
        break;
      case "ArrowLeft":
        event.preventDefault();
        seek(playback.currentTime - 10);
        break;
      case "ArrowRight":
        event.preventDefault();
        seek(playback.currentTime + 10);
        break;
      case "ArrowUp":
        event.preventDefault();
        handleVolumeChange(playback.volume + 0.05, { immediate: true });
        break;
      case "ArrowDown":
        event.preventDefault();
        handleVolumeChange(playback.volume - 0.05, { immediate: true });
        break;
      default:
        break;
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKeyboardShortcut);

    return () => {
      window.removeEventListener("keydown", handleKeyboardShortcut);
    };
  }, []);

  const handleTrackEnded = useEffectEvent(() => {
    if (!selectedTrackId) {
      return;
    }

    if (repeatMode === "one") {
      seek(0);
      void play();
      return;
    }

    if (playbackOrderMode === "shuffle") {
      const nextTrackId = pickRandomTrackId(playbackQueueIds, selectedTrackId);

      if (!nextTrackId) {
        return;
      }

      if (nextTrackId === selectedTrackId) {
        if (repeatMode === "all") {
          seek(0);
          void play();
        }
        return;
      }

      setShuffleHistory((current) => [...current, selectedTrackId].slice(-24));
      selectTrack(nextTrackId, { autoplay: true });
      return;
    }

    if (selectedQueueIndex < 0) {
      return;
    }

    const isLastTrack = selectedQueueIndex === playbackQueueIds.length - 1;
    if (isLastTrack) {
      if (repeatMode === "all" && playbackQueueIds.length) {
        const firstTrackId = playbackQueueIds[0];
        if (firstTrackId === selectedTrackId) {
          seek(0);
          void play();
        } else if (firstTrackId) {
          selectTrack(firstTrackId, { autoplay: true });
        }
      }
      return;
    }

    const nextTrackId = playbackQueueIds[selectedQueueIndex + 1];
    if (nextTrackId) {
      selectTrack(nextTrackId, { autoplay: true });
    }
  });

  useEffect(() => {
    if (endedCount < 1 || handledEndedCountRef.current === endedCount) {
      return;
    }

    handledEndedCountRef.current = endedCount;
    handleTrackEnded();
  }, [endedCount]);

  function importWarningSummary(warnings: string[]): string {
    return warnings.slice(0, 2).join(" | ");
  }

  async function handleYoutubeSearch(query: string): Promise<void> {
    const searchTerm = query.trim();
    if (!searchTerm) {
      return;
    }

    const requestId = youtubeSearchRequestRef.current + 1;
    youtubeSearchRequestRef.current = requestId;

    setActiveContextTab("youtube");
    setIsSearchingYoutube(true);
    setYoutubeNotice(null);
    setYoutubeResults([]);
    setYoutubeQuery(searchTerm);
    try {
      const results = await searchYoutubeVideos(searchTerm);
      if (youtubeSearchRequestRef.current !== requestId) {
        return;
      }

      setYoutubeResults(results);
      if (!results.length) {
        setYoutubeNotice({
          tone: "neutral",
          text: t("statusYoutubeNoResults", { query: searchTerm }),
        });
      }
    } catch (error) {
      if (youtubeSearchRequestRef.current !== requestId) {
        return;
      }

      const nextNotice = {
        tone: "danger",
        text: `${t("statusYoutubeSearchError")}: ${toErrorMessage(error)}`,
      } as const;
      setYoutubeNotice(nextNotice);
      setNotice(nextNotice);
    } finally {
      if (youtubeSearchRequestRef.current === requestId) {
        setIsSearchingYoutube(false);
      }
    }
  }

  function addDownloadedTrack(track: Track): void {
    setTracks((current) => [
      track,
      ...current.filter((existingTrack) => existingTrack.id !== track.id),
    ]);
  }

  function playDownloadedTrack(track: Track, autoplay: boolean): void {
    addDownloadedTrack(track);
    setLibraryFilter("all");

    if (selectedTrackId === track.id) {
      setActiveContextTab("lyrics");
      seek(0);
      if (autoplay) {
        void play();
      }
      return;
    }

    selectTrack(track.id, {
      autoplay,
      focusLyrics: true,
      resetShuffleHistory: true,
    });
  }

  async function handleYoutubeDownload(
    video: YouTubeVideo,
    options?: { autoplay?: boolean },
  ): Promise<void> {
    if (activeDownloadVideoRef.current) {
      return;
    }

    activeDownloadVideoRef.current = video.id;
    sawDownloadProgressRef.current = false;
    setRetryDownloadVideo(null);
    setRetryDownloadAutoplay(false);
    setActiveContextTab("downloads");
    setDownloadingVideoId(video.id);
    setDownloadProgress({
      videoId: video.id,
      title: video.title,
      phase: "queued",
      progress: 0,
    });
    const queuedNotice = {
      tone: "neutral" as const,
      text: t("statusDownloadStarted", { title: video.title }),
    };
    setDownloadNotice(queuedNotice);
    setNotice(queuedNotice);

    try {
      let downloadedTrack: Track | null = null;
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
        try {
          downloadedTrack = await downloadYoutubeAudio(video, locale);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          const shouldRetry =
            attempt < MAX_DOWNLOAD_ATTEMPTS && isRetriableDownloadError(error);
          if (!shouldRetry) {
            break;
          }

          const retryNotice = {
            tone: "neutral" as const,
            text: t("statusDownloadRetrying", {
              title: video.title,
              attempt: attempt + 1,
              max: MAX_DOWNLOAD_ATTEMPTS,
            }),
          };
          setDownloadProgress({
            videoId: video.id,
            title: video.title,
            phase: "queued",
            progress: Math.min(92, attempt * 14),
            message: retryNotice.text,
          });
          setDownloadNotice(retryNotice);
          setNotice(retryNotice);
          await sleep(retryDelayMs(attempt));
        }
      }

      if (lastError) {
        throw lastError;
      }

      if (downloadedTrack) {
        playDownloadedTrack(downloadedTrack, Boolean(options?.autoplay));
      }

      if (!sawDownloadProgressRef.current) {
        const nextNotice = {
          tone: "success" as const,
          text: t("statusDownloadComplete", { title: video.title }),
        };
        setDownloadProgress({
          videoId: video.id,
          title: video.title,
          phase: "done",
          progress: 100,
        });
        setDownloadNotice(nextNotice);
        setNotice(nextNotice);
      }

      void refreshLibrary(false);
    } catch (error) {
      const message = toErrorMessage(error);
      const nextNotice = {
        tone: "danger" as const,
        text: `${t("statusDownloadError")}: ${message}`,
      };
      setRetryDownloadVideo(video);
      setRetryDownloadAutoplay(Boolean(options?.autoplay));
      setDownloadProgress({
        videoId: video.id,
        title: video.title,
        phase: "error",
        progress: 100,
        message,
      });
      setDownloadNotice(nextNotice);
      setNotice(nextNotice);
    } finally {
      activeDownloadVideoRef.current = null;
      setDownloadingVideoId(null);
    }
  }

  async function handleImport(): Promise<void> {
    setIsImporting(true);

    try {
      const result = await importLocalTracks();
      const importedTracks = result.tracks;
      if (result.cancelled) {
        setNotice({
          tone: "neutral",
          text: t("statusImportCancelled"),
        });
        return;
      }

      if (!importedTracks.length) {
        const summary = importWarningSummary(result.warnings);
        setNotice({
          tone: result.warnings.length ? "danger" : "neutral",
          text: summary
            ? `${t("statusImportNoTracks")}: ${summary}`
            : t("statusImportNoTracks"),
        });
        return;
      }

      setTracks((current) => {
        const incoming = [...importedTracks, ...current];
        const seen = new Set<string>();
        return incoming.filter((track) => {
          if (seen.has(track.id)) {
            return false;
          }
          seen.add(track.id);
          return true;
        });
      });

      if (importedTracks[0]?.id) {
        selectTrack(importedTracks[0].id, {
          focusLyrics: true,
          resetShuffleHistory: true,
        });
      }
      const summary = importWarningSummary(result.warnings);
      const importText =
        result.skipped > 0 || summary
          ? `${t("statusImportPartial", {
              count: importedTracks.length,
              skipped: result.skipped,
            })}${summary ? `: ${summary}` : ""}`
          : t("statusImportSuccess", { count: importedTracks.length });

      setNotice({
        tone: "success",
        text: importText,
      });
      void refreshLibrary(false);
    } catch (error) {
      setNotice({
        tone: "danger",
        text: `${t("statusImportError")}: ${toErrorMessage(error)}`,
      });
    } finally {
      setIsImporting(false);
    }
  }

  async function handleDeleteTrack(track: Track): Promise<void> {
    if (deletingTrackId) {
      return;
    }

    if (track.source === "demo") {
      setNotice({
        tone: "neutral",
        text: t("statusDemoDeleteBlocked"),
      });
      return;
    }

    if (!window.confirm(t("trackDeleteConfirm", { title: track.title }))) {
      return;
    }

    setDeletingTrackId(track.id);
    try {
      const result = await deleteTrack(track.id);
      if (!result.deletedTrackId) {
        setNotice({
          tone: "neutral",
          text: t("statusDeleteMissing"),
        });
        void refreshLibrary(false);
        return;
      }

      const deletedIndex = tracks.findIndex((item) => item.id === track.id);
      const nextTracks = tracks.filter((item) => item.id !== track.id);
      setTracks(nextTracks);
      setQueueTrackIds((current) => removeTrackFromQueue(current, track.id));
      setShuffleHistory((current) => current.filter((trackId) => trackId !== track.id));

      if (selectedTrackId === track.id) {
        autoplayNextSelectionRef.current = false;
        const nextSelection =
          nextTracks[deletedIndex] ?? nextTracks[deletedIndex - 1] ?? nextTracks[0] ?? null;
        setSelectedTrackId(nextSelection?.id ?? null);
      }

      const firstWarning = result.warnings[0];
      setNotice({
        tone: firstWarning ? "neutral" : "success",
        text: firstWarning
          ? t("statusDeletePartial", { title: track.title, warning: firstWarning })
          : t("statusDeleteSuccess", { title: track.title }),
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        text: `${t("statusDeleteError")}: ${toErrorMessage(error)}`,
      });
    } finally {
      setDeletingTrackId(null);
    }
  }

  const contextTabs = [
    { id: "lyrics" as const, label: t("contextLyricsTab"), icon: TextQuote },
    { id: "youtube" as const, label: t("contextYoutubeTab"), icon: Search },
    { id: "downloads" as const, label: t("contextDownloadsTab"), icon: Download },
  ];
  const libraryFilters = [
    { id: "all" as const, label: t("libraryFilterAll"), count: tracks.length },
    { id: "favorites" as const, label: t("libraryFilterFavorites"), count: favoriteTracksCount },
    { id: "recent" as const, label: t("libraryFilterRecent"), count: recentTracksCount },
    { id: "local" as const, label: t("libraryFilterLocal"), count: localTracksCount },
    { id: "youtube" as const, label: t("libraryFilterYouTube"), count: youtubeTracksCount },
  ];
  const sortOptions = [
    { id: "added" as const, label: t("librarySortAdded") },
    { id: "title" as const, label: t("librarySortTitle") },
    { id: "artist" as const, label: t("librarySortArtist") },
    { id: "duration" as const, label: t("librarySortDuration") },
    { id: "lastPlayed" as const, label: t("librarySortLastPlayed") },
  ];
  const activeMenuTrack = trackMenu
    ? tracks.find((track) => track.id === trackMenu.trackId) ?? null
    : null;
  const dependencyCards = [
    {
      label: t("dependencyYtDlp"),
      ready: Boolean(bootstrapMeta?.dependencyStatus?.ytDlpReady),
    },
    {
      label: t("dependencyFfmpeg"),
      ready: Boolean(bootstrapMeta?.dependencyStatus?.ffmpegReady),
    },
  ];

  return (
    <div className={["music-app", isLibraryOpen ? "music-app--library-open" : ""].join(" ")}>
      <div className="music-app__shell" style={stageStyle}>
        <div className="music-app__shell-glow" aria-hidden="true" />

        <header className="music-app__header">
          <div className="app-title">
            <div className="app-title__copy">
              <h1>{t("appTagline")}</h1>
              <p>
                {runtimeHint}
                {" · "}
                {isBootstrapping ? t("statusPreparing") : t("statusReady")}
              </p>
            </div>
          </div>

          <div className="header-actions">
            <button
              type="button"
              className="secondary-button library-toggle"
              aria-controls="library-rail"
              aria-expanded={isLibraryOpen}
              aria-keyshortcuts="Meta+O"
              title={`${isLibraryOpen ? t("libraryHideAction") : t("libraryShowAction")} (Command + O)`}
              onClick={() => setIsLibraryOpen((current) => !current)}
            >
              {isLibraryOpen ? (
                <PanelLeftClose size={16} strokeWidth={2.2} aria-hidden="true" />
              ) : (
                <PanelLeftOpen size={16} strokeWidth={2.2} aria-hidden="true" />
              )}
              {isLibraryOpen ? t("libraryHideAction") : t("libraryShowAction")}
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-keyshortcuts="Meta+R"
              title={`${t("refreshAction")} (Command + R)`}
              onClick={() => void refreshLibrary(true)}
            >
              <RefreshCw size={16} strokeWidth={2.2} aria-hidden="true" />
              {t("refreshAction")}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void handleImport()}
              disabled={isImporting}
            >
              <ArrowDownToLine size={16} strokeWidth={2.2} aria-hidden="true" />
              {isImporting ? t("importingAction") : t("importAction")}
            </button>
            <div className="locale-switch" role="tablist" aria-label={t("languageSwitcherLabel")}>
              {localeOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={option === locale}
                  className={[
                    "locale-switch__button",
                    option === locale ? "locale-switch__button--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => setLocale(option)}
                  onKeyDown={(event) => {
                    if (!isKeyboardActivation(event.key)) {
                      return;
                    }

                    event.preventDefault();
                    setLocale(option);
                  }}
                >
                  {option === "en" ? t("languageEnglish") : t("languageChinese")}
                </button>
              ))}
            </div>
          </div>
        </header>

        <main className="music-app__content">
          <button
            type="button"
            className="library-backdrop"
            aria-label={t("libraryCloseAction")}
            onClick={() => setIsLibraryOpen(false)}
          />
          <aside id="library-rail" className="library-rail">
            <button
              type="button"
              className="library-drawer-close"
              aria-label={t("libraryCloseAction")}
              onClick={() => setIsLibraryOpen(false)}
            >
              <X size={16} strokeWidth={2.2} aria-hidden="true" />
              {t("libraryCloseAction")}
            </button>
            <label className="search-field library-search" aria-label={t("toolbarSearchPlaceholder")}>
              <Search size={16} strokeWidth={2.1} aria-hidden="true" />
              <input
                defaultValue={libraryQuery}
                aria-label={t("toolbarSearchPlaceholder")}
                placeholder={t("toolbarSearchPlaceholder")}
                onCompositionStart={() => {
                  isComposingLibraryQueryRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  isComposingLibraryQueryRef.current = false;
                  startTransition(() => {
                    setLibraryQuery(event.currentTarget.value);
                  });
                }}
                onChange={(event) => {
                  if (
                    isComposingLibraryQueryRef.current ||
                    isComposingInputEvent(event.nativeEvent)
                  ) {
                    return;
                  }

                  startTransition(() => {
                    setLibraryQuery(event.currentTarget.value);
                  });
                }}
              />
            </label>

            <section className="rail-card rail-card--list">
              <div className="rail-card__header">
                <div>
                  <p className="rail-card__eyebrow">{t("librarySectionLabel")}</p>
                  <h3>{t("libraryTitle")}</h3>
                </div>
                <span className="chip chip--soft">{visibleTracks.length}</span>
              </div>

              <div className="source-filter" role="tablist" aria-label={t("libraryFilterLabel")}>
                {libraryFilters.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    role="tab"
                    aria-selected={filter.id === libraryFilter}
                    className={[
                      "source-filter__button",
                      filter.id === libraryFilter ? "source-filter__button--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setLibraryFilter(filter.id)}
                    onKeyDown={(event) => {
                      if (!isKeyboardActivation(event.key)) {
                        return;
                      }

                      event.preventDefault();
                      setLibraryFilter(filter.id);
                    }}
                  >
                    <span>{filter.label}</span>
                    <span>{filter.count}</span>
                  </button>
                ))}
              </div>

              <div className="library-controls" aria-label={t("librarySortLabel")}>
                <label className="library-sort">
                  <span>{t("librarySortLabel")}</span>
                  <select
                    value={librarySort}
                    onChange={(event) =>
                      setLibrarySort(event.currentTarget.value as LibrarySortMode)
                    }
                  >
                    {sortOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="tiny-button library-sort__direction"
                  onClick={() =>
                    setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
                  }
                  aria-label={
                    sortDirection === "asc"
                      ? t("librarySortDescending")
                      : t("librarySortAscending")
                  }
                  title={
                    sortDirection === "asc"
                      ? t("librarySortAscending")
                      : t("librarySortDescending")
                  }
                >
                  {sortDirection === "asc" ? (
                    <SortAsc size={15} strokeWidth={2.2} aria-hidden="true" />
                  ) : (
                    <SortDesc size={15} strokeWidth={2.2} aria-hidden="true" />
                  )}
                  {sortDirection === "asc"
                    ? t("librarySortAscending")
                    : t("librarySortDescending")}
                </button>
              </div>

              {queueTracks.length ? (
                <section className="queue-card" aria-label={t("queueTitle")}>
                  <header className="queue-card__header">
                    <div>
                      <span>{t("queueTitle")}</span>
                      <strong>{t("queueCount", { count: queueTracks.length })}</strong>
                    </div>
                    <button
                      type="button"
                      className="tiny-button"
                      onClick={handleClearQueue}
                    >
                      <Eraser size={14} strokeWidth={2.2} aria-hidden="true" />
                      {t("queueClear")}
                    </button>
                  </header>
                  <ol className="queue-card__list">
                    {queueTracks.slice(0, 4).map((track, index) => (
                      <li key={track.id}>
                        <button
                          type="button"
                          onClick={() => {
                            selectTrack(track.id, {
                              autoplay: true,
                              focusLyrics: true,
                              resetShuffleHistory: true,
                            });
                            setIsLibraryOpen(false);
                          }}
                        >
                          <span>{index + 1}</span>
                          <strong title={track.title}>{track.title}</strong>
                        </button>
                        <button
                          type="button"
                          aria-label={`${t("trackRemoveFromQueue")}: ${track.title}`}
                          onClick={() => handleRemoveFromQueue(track)}
                        >
                          <X size={13} strokeWidth={2.2} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              {!tracks.length ? (
                <div className="empty-state empty-state--rail">
                  <h3>{t("libraryEmptyTitle")}</h3>
                  <p>{t("libraryEmptyDescription")}</p>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void handleImport()}
                    disabled={isImporting}
                  >
                    <ArrowDownToLine size={16} strokeWidth={2.2} aria-hidden="true" />
                    {isImporting ? t("importingAction") : t("importAction")}
                  </button>
                </div>
              ) : visibleTracks.length ? (
                <TrackList
                  tracks={visibleTracks}
                  selectedTrackId={selectedTrackId}
                  currentTrackId={selectedTrack?.id ?? null}
                  isPlaying={playback.isPlaying}
                  locale={locale}
                  queuedTrackIds={queueTrackIds}
                  onSelect={(trackId) => {
                    selectTrack(trackId, {
                      focusLyrics: true,
                      resetShuffleHistory: true,
                    });
                    setIsLibraryOpen(false);
                  }}
                  onPlay={(track) => {
                    if (selectedTrack?.id === track.id) {
                      void togglePlayback();
                      setIsLibraryOpen(false);
                      return;
                    }

                    selectTrack(track.id, {
                      autoplay: true,
                      focusLyrics: true,
                      resetShuffleHistory: true,
                    });
                    setIsLibraryOpen(false);
                  }}
                  onToggleFavorite={(track) => void handleToggleFavorite(track)}
                  onAddToQueue={(track, placement) => handleAddToQueue(track, placement)}
                  onRemoveFromQueue={(track) => handleRemoveFromQueue(track)}
                  onOpenMenu={(track, x, y) => openTrackMenu(track, x, y)}
                  onDelete={(track) => void handleDeleteTrack(track)}
                  deletingTrackId={deletingTrackId}
                  t={t}
                />
              ) : (
                <div className="empty-state empty-state--rail">
                  <h3>{t("libraryTitle")}</h3>
                  <p>{t("librarySearchEmpty")}</p>
                </div>
              )}
            </section>
            <div className="rail-stats">
              <article className="stat-card">
                <Disc3 size={16} strokeWidth={2.2} aria-hidden="true" />
                <div>
                  <strong>{t("statTracks", { count: tracks.length })}</strong>
                  <span>{t("libraryFilterLocal")} / {t("libraryFilterYouTube")}</span>
                </div>
              </article>
              <article className="stat-card">
                <TextQuote size={16} strokeWidth={2.2} aria-hidden="true" />
                <div>
                  <strong>{t("statLyrics", { count: lyricsCount })}</strong>
                  <span>{t("lyricsTitle")}</span>
                </div>
              </article>
              <article className="stat-card">
                <Download size={16} strokeWidth={2.2} aria-hidden="true" />
                <div>
                  <strong>{t("statDownloads", { count: activeDownloads })}</strong>
                  <span>{t("contextDownloadsTab")}</span>
                </div>
              </article>
            </div>
          </aside>

          <section className="listening-stage" style={stageStyle}>
            <div className="listening-stage__ambient" aria-hidden="true">
              {artworkUrl ? (
                <div
                  className="listening-stage__artwork-blur"
                  style={{ backgroundImage: `url(${artworkUrl})` }}
                />
              ) : null}
            </div>

            <div className="listening-stage__inner">
              <NowPlayingCard
                track={selectedTrack}
                artworkUrl={artworkUrl}
                locale={locale}
                currentTime={playback.currentTime}
                duration={playback.duration}
                isPlaying={playback.isPlaying}
                canPlay={playback.canPlay}
                volume={playback.volume}
                error={playback.error}
                audioRef={audioRef}
                playbackOrderMode={playbackOrderMode}
                repeatMode={repeatMode}
                canPlayPrevious={canPlayPrevious}
                canPlayNext={canPlayNext}
                onPrevious={handlePreviousTrack}
                onNext={handleNextTrack}
                onTogglePlaybackOrderMode={() => {
                  setShuffleHistory([]);
                  setPlaybackOrderMode((current) =>
                    current === "normal" ? "shuffle" : "normal",
                  );
                }}
                onCycleRepeatMode={() =>
                  setRepeatMode((current) => cycleRepeatMode(current))
                }
                onTogglePlayback={togglePlayback}
                onSeek={seek}
                onVolumeChange={(value) => handleVolumeChange(value)}
                t={t}
              />
            </div>
          </section>

          <aside className="context-rail">
            <div className="context-tabs" role="tablist" aria-label={t("contextTabsLabel")}>
              {contextTabs.map((tab) => {
                const Icon = tab.icon;

                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeContextTab === tab.id}
                    className={[
                      "context-tab",
                      activeContextTab === tab.id ? "context-tab--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setActiveContextTab(tab.id)}
                    onKeyDown={(event) => {
                      if (!isKeyboardActivation(event.key)) {
                        return;
                      }

                      event.preventDefault();
                      setActiveContextTab(tab.id);
                    }}
                  >
                    <Icon size={15} strokeWidth={2.2} aria-hidden="true" />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="context-rail__body">
              {activeContextTab === "lyrics" ? (
                <LyricsPanel
                  track={selectedTrack}
                  currentTime={playback.currentTime}
                  isLoading={isLoadingLyrics}
                  error={lyricsError}
                  status={lyricsNotice?.text ?? null}
                  statusTone={lyricsNotice?.tone ?? "neutral"}
                  lyricOffsetMs={selectedTrack?.lyricOffsetMs ?? 0}
                  onLyricOffsetChange={(offsetMs) => {
                    if (!selectedTrack) {
                      return;
                    }

                    void handleLyricOffsetChange(selectedTrack.id, offsetMs);
                  }}
                  onRefreshLyrics={async () => {
                    if (!selectedTrack) {
                      return;
                    }

                    setIsLoadingLyrics(true);
                    setLyricsError(undefined);
                    setLyricsNotice(null);

                    try {
                      const lyrics = await searchLyricsForTrack(selectedTrack);

                      if (!lyrics?.length) {
                        const nextNotice = {
                          tone: "neutral" as const,
                          text: t("statusLyricsMissing", { title: selectedTrack.title }),
                        };
                        setLyricsNotice(nextNotice);
                        setNotice(nextNotice);
                        return;
                      }

                      startTransition(() => {
                        setTracks((current) =>
                          current.map((track) =>
                            track.id === selectedTrack.id
                              ? {
                                  ...track,
                                  lyrics,
                                  lyricSource: "search_lyrics_for_track",
                                }
                              : track,
                          ),
                        );
                      });
                      const nextNotice = {
                        tone: "success" as const,
                        text: t("statusLyricsSuccess", { title: selectedTrack.title }),
                      };
                      setLyricsNotice(nextNotice);
                      setNotice(nextNotice);
                    } catch (error) {
                      const message = toErrorMessage(error);
                      const nextNotice = {
                        tone: "danger" as const,
                        text: `${t("statusLyricsError")}: ${message}`,
                      };
                      setLyricsError(message);
                      setLyricsNotice(nextNotice);
                      setNotice(nextNotice);
                    } finally {
                      setIsLoadingLyrics(false);
                    }
                  }}
                  t={t}
                />
              ) : null}

              {activeContextTab === "youtube" ? (
                <YouTubePanel
                  query={youtubeQuery}
                  results={youtubeResults}
                  selectedTrack={selectedTrack}
                  searching={isSearchingYoutube}
                  downloadingVideoId={downloadingVideoId}
                  status={youtubeNotice}
                  searchInputRef={youtubeSearchInputRef}
                  onQueryChange={(value) => {
                    setYoutubeQuery(value);
                  }}
                  onSearch={handleYoutubeSearch}
                  onDownload={(video) => void handleYoutubeDownload(video)}
                  onActivate={(video) =>
                    void handleYoutubeDownload(video, { autoplay: true })
                  }
                  onUseCurrentTrack={() => {
                    if (!selectedTrack) {
                      return;
                    }

                    void handleYoutubeSearch(
                      `${selectedTrack.title} ${selectedTrack.artist}`.trim(),
                    );
                  }}
                  t={t}
                />
              ) : null}

              {activeContextTab === "downloads" ? (
                <DownloadPanel
                  progress={downloadProgress}
                  status={downloadNotice}
                  onRetry={
                    retryDownloadVideo
                      ? () =>
                          void handleYoutubeDownload(retryDownloadVideo, {
                            autoplay: retryDownloadAutoplay,
                          })
                      : undefined
                  }
                  t={t}
                />
              ) : null}
            </div>

            <footer className="context-footer">
              <div className="context-footer__meta">
                <span>{t("contextFooterLabel")}</span>
                <strong>{runtimeHint}</strong>
              </div>
              {bootstrapMeta?.libraryDir ? (
                <button
                  type="button"
                  className="storage-location"
                  onClick={() => void handleOpenSavedLibrary()}
                  aria-label={`${t("storageLocationLabel")}: ${t("storageOpenAction")}`}
                >
                  <span>{t("storageLocationLabel")}</span>
                  <strong>{t("storageOpenAction")}</strong>
                </button>
              ) : null}
              <div className="dependency-grid">
                {dependencyCards.map((item) => (
                  <article key={item.label} className="dependency-card">
                    <span>{item.label}</span>
                    <strong>
                      {item.ready ? t("dependencyReady") : t("dependencyPreparing")}
                    </strong>
                  </article>
                ))}
              </div>
            </footer>
          </aside>
        </main>

        {trackMenu && activeMenuTrack ? (
          <div
            className="track-context-menu"
            role="menu"
            style={{ left: trackMenu.x, top: trackMenu.y } as CSSProperties}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="track-context-menu__title">
              <strong title={activeMenuTrack.title}>{activeMenuTrack.title}</strong>
              <span>{activeMenuTrack.artist}</span>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                selectTrack(activeMenuTrack.id, {
                  autoplay: true,
                  focusLyrics: true,
                  resetShuffleHistory: true,
                });
                setTrackMenu(null);
              }}
            >
              <Play size={15} strokeWidth={2.3} fill="currentColor" aria-hidden="true" />
              {t("trackPlay")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleAddToQueue(activeMenuTrack, "next")}
            >
              <ListMusic size={15} strokeWidth={2.2} aria-hidden="true" />
              {t("trackPlayNext")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleAddToQueue(activeMenuTrack, "end")}
            >
              <ListMusic size={15} strokeWidth={2.2} aria-hidden="true" />
              {t("trackAddToQueue")}
            </button>
            {queuedTrackIdSet.has(activeMenuTrack.id) ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => handleRemoveFromQueue(activeMenuTrack)}
              >
                <X size={15} strokeWidth={2.2} aria-hidden="true" />
                {t("trackRemoveFromQueue")}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleToggleFavorite(activeMenuTrack)}
            >
              <Star
                size={15}
                strokeWidth={2.2}
                fill={activeMenuTrack.isFavorite ? "currentColor" : "none"}
                aria-hidden="true"
              />
              {activeMenuTrack.isFavorite ? t("trackUnfavorite") : t("trackFavorite")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="track-context-menu__danger"
              onClick={() => {
                setTrackMenu(null);
                void handleDeleteTrack(activeMenuTrack);
              }}
            >
              <Trash2 size={15} strokeWidth={2.2} aria-hidden="true" />
              {t("trackDelete")}
            </button>
          </div>
        ) : null}

        {notice ? (
          <div className={["notice-toast", `notice-toast--${notice.tone}`].join(" ")}>
            {notice.text}
          </div>
        ) : null}

        <audio ref={audioRef} src={audioSource} preload="metadata" hidden />
      </div>
    </div>
  );
}

export default App;
