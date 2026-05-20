import { useEffect, useEffectEvent, useRef, useState } from "react";

import { clamp, toErrorMessage } from "../lib/format";
import type { Track } from "../types";

interface PlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  canPlay: boolean;
  volume: number;
  error?: string;
}

interface AudioPlayerOptions {
  volumeMode?: "element" | "system";
}

export function useAudioPlayer(
  track: Track | null,
  sourceUrl?: string,
  options: AudioPlayerOptions = {},
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controlsSystemVolume = options.volumeMode === "system";
  const playIntentRef = useRef(false);
  const playRequestIdRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const lastFrameSyncRef = useRef(0);
  const [endedCount, setEndedCount] = useState(0);
  const [playback, setPlayback] = useState<PlaybackState>({
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    canPlay: Boolean(sourceUrl),
    volume: 0.9,
  });

  const stopProgressTicker = useEffectEvent(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastFrameSyncRef.current = 0;
  });

  const syncFromElement = useEffectEvent((force = false) => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const nextDuration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : (track?.durationSec ?? 0);
    const nextIsPlaying = !audio.paused;

    setPlayback((current) => {
      if (
        !force &&
        Math.abs(current.currentTime - audio.currentTime) < 0.04 &&
        Math.abs(current.duration - nextDuration) < 0.04 &&
        current.isPlaying === nextIsPlaying &&
        current.canPlay === Boolean(sourceUrl) &&
        !current.error
      ) {
        return current;
      }

      return {
        ...current,
        currentTime: audio.currentTime,
        duration: nextDuration,
        isPlaying: nextIsPlaying,
        canPlay: Boolean(sourceUrl),
        error: undefined,
      };
    });
  });

  const startProgressTicker = useEffectEvent(() => {
    if (frameRef.current !== null) {
      return;
    }

    const tick = (timestamp: number) => {
      const audio = audioRef.current;
      if (!audio || audio.paused || audio.ended) {
        stopProgressTicker();
        return;
      }

      if (!lastFrameSyncRef.current || timestamp - lastFrameSyncRef.current >= 160) {
        lastFrameSyncRef.current = timestamp;
        syncFromElement();
      }

      frameRef.current = window.requestAnimationFrame(tick);
    };

    frameRef.current = window.requestAnimationFrame(tick);
  });

  const startPlayback = useEffectEvent(async () => {
    const audio = audioRef.current;
    if (!audio || !sourceUrl) {
      return;
    }

    playIntentRef.current = true;
    const requestId = playRequestIdRef.current + 1;
    playRequestIdRef.current = requestId;

    try {
      await audio.play();
      if (playRequestIdRef.current !== requestId || !playIntentRef.current) {
        audio.pause();
        syncFromElement(true);
        return;
      }

      syncFromElement(true);
      startProgressTicker();
    } catch (error) {
      if (playRequestIdRef.current !== requestId) {
        return;
      }

      playIntentRef.current = false;
      stopProgressTicker();
      setPlayback((current) => ({
        ...current,
        isPlaying: false,
        error: toErrorMessage(error),
      }));
    }
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.volume = controlsSystemVolume ? 1 : playback.volume;
  }, [controlsSystemVolume, playback.volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const handleError = () => {
      const mediaError = audio.error?.message ?? "Audio playback failed";
      playIntentRef.current = false;
      stopProgressTicker();
      setPlayback((current) => ({
        ...current,
        isPlaying: false,
        canPlay: Boolean(sourceUrl),
        error: mediaError,
      }));
    };

    const handleEnded = () => {
      playIntentRef.current = false;
      stopProgressTicker();
      setPlayback((current) => ({
        ...current,
        currentTime:
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : current.duration,
        isPlaying: false,
      }));
      setEndedCount((current) => current + 1);
    };

    const handleLoadedMetadata = () => syncFromElement(true);
    const handleTimeUpdate = () => syncFromElement();
    const handlePlay = () => {
      if (!playIntentRef.current) {
        audio.pause();
        return;
      }

      syncFromElement(true);
      startProgressTicker();
    };
    const handlePause = () => {
      stopProgressTicker();
      syncFromElement(true);
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("canplay", handleLoadedMetadata);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("durationchange", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      stopProgressTicker();
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("canplay", handleLoadedMetadata);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("durationchange", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [sourceUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    stopProgressTicker();
    playIntentRef.current = false;
    playRequestIdRef.current += 1;
    audio.pause();
    if (sourceUrl) {
      audio.load();
    }
    setPlayback((current) => ({
      ...current,
      currentTime: 0,
      duration: track?.durationSec ?? 0,
      isPlaying: false,
      canPlay: Boolean(sourceUrl),
      error: undefined,
    }));

  }, [sourceUrl, track?.id]);

  useEffect(() => {
    return () => {
      stopProgressTicker();
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const audio = audioRef.current;
      if (!audio) {
        return;
      }

      if (document.hidden) {
        stopProgressTicker();
        return;
      }

      syncFromElement(true);
      if (!audio.paused && !audio.ended) {
        startProgressTicker();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current;
    if (!audio || !sourceUrl) {
      return;
    }

    if (audio.paused) {
      await startPlayback();
      return;
    }

    playIntentRef.current = false;
    playRequestIdRef.current += 1;
    stopProgressTicker();
    audio.pause();
    syncFromElement(true);
  }

  function seek(nextTime: number): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : playback.duration || track?.durationSec || 0;
    const safeTime = clamp(nextTime, 0, duration || 0);
    audio.currentTime = safeTime;
    setPlayback((current) => ({
      ...current,
      currentTime: safeTime,
      duration: duration || current.duration,
    }));
  }

  function setVolume(nextVolume: number): void {
    const safeVolume = clamp(nextVolume, 0, 1);
    const audio = audioRef.current;
    if (audio && !controlsSystemVolume) {
      audio.volume = safeVolume;
    }

    setPlayback((current) =>
      Math.abs(current.volume - safeVolume) < 0.005
        ? current
        : {
            ...current,
            volume: safeVolume,
          },
    );
  }

  return {
    audioRef,
    endedCount,
    playback,
    play: startPlayback,
    togglePlayback,
    seek,
    setVolume,
  };
}
