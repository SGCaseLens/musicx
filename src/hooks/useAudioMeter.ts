import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

const BAND_COUNT = 12;
const REST_LEVELS = Array.from({ length: BAND_COUNT }, (_, index) => 0.08 + index * 0.018);

type AudioContextConstructor = typeof AudioContext;
type AudioMeterSourceNode = MediaElementAudioSourceNode | MediaStreamAudioSourceNode;
type AudioMeterSourceKind = "element" | "stream";

type CapturableAudioElement = HTMLAudioElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

function audioContextConstructor(): AudioContextConstructor | null {
  const candidate = window as Window &
    typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
  return candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
}

function captureAudioStream(audio: HTMLAudioElement): MediaStream | null {
  const candidate = audio as CapturableAudioElement;
  return candidate.captureStream?.() ?? candidate.mozCaptureStream?.() ?? null;
}

function bandsFromFrequencyData(
  frequencyData: Uint8Array,
  previousLevels: number[],
): number[] {
  const usableBins = Math.max(1, Math.floor(frequencyData.length * 0.74));

  return Array.from({ length: BAND_COUNT }, (_, band) => {
    const startRatio = Math.pow(band / BAND_COUNT, 1.55);
    const endRatio = Math.pow((band + 1) / BAND_COUNT, 1.55);
    const start = Math.min(usableBins - 1, Math.floor(startRatio * usableBins));
    const end = Math.max(start + 1, Math.min(usableBins, Math.floor(endRatio * usableBins)));
    let sum = 0;
    let peak = 0;

    for (let index = start; index < end; index += 1) {
      const value = frequencyData[index] ?? 0;
      sum += value;
      peak = Math.max(peak, value);
    }

    const average = sum / Math.max(1, end - start) / 255;
    const peakLevel = peak / 255;
    const shaped = Math.min(1, Math.pow(average * 1.9, 0.72) + peakLevel * 0.26);
    const floor = REST_LEVELS[band] ?? 0.08;
    const previous = previousLevels[band] ?? floor;
    return previous * 0.34 + Math.max(floor, shaped) * 0.66;
  });
}

export function useAudioMeter(
  audioRef: RefObject<HTMLAudioElement | null>,
  isPlaying: boolean,
): number[] {
  const [levels, setLevels] = useState<number[]>(REST_LEVELS);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioMeterSourceNode | null>(null);
  const sourceKindRef = useRef<AudioMeterSourceKind | null>(null);
  const sourceUrlRef = useRef("");
  const frequencyDataRef = useRef<Uint8Array | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastRenderRef = useRef(0);
  const levelsRef = useRef<number[]>(REST_LEVELS);
  const isStartingRef = useRef(false);
  const runIdRef = useRef(0);

  const stopMeter = useEffectEvent(() => {
    runIdRef.current += 1;
    isStartingRef.current = false;

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    lastRenderRef.current = 0;
    levelsRef.current = REST_LEVELS;
    setLevels((current) => (current === REST_LEVELS ? current : REST_LEVELS));
  });

  const ensureAnalyser = useEffectEvent(async (): Promise<AnalyserNode | null> => {
    const audio = audioRef.current;
    if (!audio) {
      return null;
    }

    const Context = audioContextConstructor();
    if (!Context) {
      return null;
    }

    const context = audioContextRef.current ?? new Context();
    audioContextRef.current = context;
    const currentSourceUrl = audio.currentSrc || audio.src;

    if (
      sourceRef.current &&
      sourceKindRef.current === "stream" &&
      sourceUrlRef.current !== currentSourceUrl
    ) {
      sourceRef.current.disconnect();
      analyserRef.current?.disconnect();
      sourceRef.current = null;
      sourceKindRef.current = null;
      analyserRef.current = null;
      frequencyDataRef.current = null;
      sourceUrlRef.current = "";
    }

    if (!sourceRef.current) {
      try {
        const capturedStream = captureAudioStream(audio);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.68;

        const source = capturedStream
          ? context.createMediaStreamSource(capturedStream)
          : context.createMediaElementSource(audio);
        source.connect(analyser);
        if (!capturedStream) {
          analyser.connect(context.destination);
        }

        sourceRef.current = source;
        sourceKindRef.current = capturedStream ? "stream" : "element";
        analyserRef.current = analyser;
        sourceUrlRef.current = currentSourceUrl;
        frequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        return null;
      }
    }

    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        return null;
      }
    }

    return analyserRef.current;
  });

  const startMeter = useEffectEvent(async () => {
    if (frameRef.current !== null || isStartingRef.current) {
      return;
    }

    isStartingRef.current = true;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    const analyser = await ensureAnalyser();
    const frequencyData = frequencyDataRef.current;
    isStartingRef.current = false;

    if (
      runId !== runIdRef.current ||
      !analyser ||
      !frequencyData ||
      !audioRef.current ||
      audioRef.current.paused ||
      audioRef.current.ended
    ) {
      return;
    }

    const tick = (timestamp: number) => {
      if (runId !== runIdRef.current) {
        return;
      }

      if (!audioRef.current || audioRef.current.paused || audioRef.current.ended) {
        stopMeter();
        return;
      }

      if (!lastRenderRef.current || timestamp - lastRenderRef.current >= 34) {
        analyser.getByteFrequencyData(frequencyData);
        const nextLevels = bandsFromFrequencyData(frequencyData, levelsRef.current);
        levelsRef.current = nextLevels;
        setLevels(nextLevels);
        lastRenderRef.current = timestamp;
      }

      frameRef.current = window.requestAnimationFrame(tick);
    };

    frameRef.current = window.requestAnimationFrame(tick);
  });

  useEffect(() => {
    if (!isPlaying) {
      stopMeter();
      return;
    }

    void startMeter();
  }, [isPlaying]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopMeter();
        return;
      }

      if (isPlaying) {
        void startMeter();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      stopMeter();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      analyserRef.current = null;
      sourceRef.current = null;
      sourceKindRef.current = null;
      sourceUrlRef.current = "";
      frequencyDataRef.current = null;
    };
  }, []);

  return levels;
}
