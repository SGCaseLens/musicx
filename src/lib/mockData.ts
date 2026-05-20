import type {
  BootstrapResult,
  DownloadProgress,
  LyricsLine,
  Locale,
  Track,
  YouTubeVideo,
} from "../types";

function makeLyrics(lines: Array<[number, string, string?]>): LyricsLine[] {
  return lines.map(([time, text, translation], index) => ({
    id: `mock-lyric-${index}-${time}`,
    time,
    text,
    translation,
  }));
}

function makeTrack(
  id: string,
  track: Omit<Track, "id" | "source"> & { source?: Track["source"] },
): Track {
  return {
    id,
    source: track.source ?? "demo",
    ...track,
  };
}

const seededTracks: Track[] = [
  makeTrack("track-neon-harbor", {
    title: "Neon Harbor",
    artist: "Mira Sol",
    album: "Postcards After Rain",
    durationSec: 223,
    importedAt: "2026-04-18T10:30:00.000Z",
    lyrics: makeLyrics([
      [0, "Wake the city with a half-lit glow", "在半明半暗里唤醒城市"],
      [18, "Taxi lights sliding like a river below", "计程车灯像河流一样滑过"],
      [37, "You say stay slow, let the morning show", "你说慢一点，让清晨自己展开"],
      [58, "Neon harbor, keep me close to home", "霓虹港湾，把我留在熟悉的地方"],
      [82, "Every rooftop singing through the drizzle air", "每个屋顶都在细雨里轻轻唱着"],
      [108, "We were gold dust leaning into nowhere", "我们像金粉一样靠向未知"],
      [142, "Hold that note until the skyline glows", "把那个音拖到天边发亮"],
      [188, "Neon harbor, never let me go", "霓虹港湾，别让我离开"],
    ]),
    lyricSource: "embedded demo",
  }),
  makeTrack("track-paper-crane", {
    title: "Paper Crane",
    artist: "Blue Sunday",
    album: "Soft Corners",
    durationSec: 196,
    importedAt: "2026-04-20T04:12:00.000Z",
    lyrics: makeLyrics([
      [0, "Fold another paper crane for luck"],
      [24, "Leave it by the window in the dust"],
      [48, "Every little wish becomes a map"],
      [72, "Every little map becomes a song"],
      [103, "If the rain keeps time then we belong"],
      [138, "Paper wings can still survive the dark"],
      [170, "Paper crane, bring me back to us"],
    ]),
    lyricSource: "subtitle conversion demo",
  }),
  makeTrack("track-velvet-dawn", {
    title: "Velvet Dawn",
    artist: "North Arcade",
    album: "Static Bloom",
    durationSec: 244,
    importedAt: "2026-04-21T14:05:00.000Z",
  }),
];

const importQueue: Track[] = [
  makeTrack("track-late-checkout", {
    title: "Late Checkout",
    artist: "Cedar Motel",
    album: "Lobby Echoes",
    durationSec: 205,
    importedAt: "2026-04-24T09:00:00.000Z",
    source: "local",
  }),
  makeTrack("track-summer-switchbacks", {
    title: "Summer Switchbacks",
    artist: "Field Manual",
    album: "Open Roads Club",
    durationSec: 231,
    importedAt: "2026-04-24T09:10:00.000Z",
    source: "local",
  }),
];

let mockLibrary: Track[] = [...seededTracks];

function dedupeTracks(tracks: Track[]): Track[] {
  const map = new Map<string, Track>();
  tracks.forEach((track) => {
    map.set(track.id, track);
  });
  return [...map.values()];
}

export function getMockBootstrap(locale: Locale): BootstrapResult {
  return {
    locale,
    tracks: getMockTracks(),
    libraryName: "Demo Library",
    lastIndexedAt: "2026-04-25T00:00:00.000Z",
  };
}

export function getMockTracks(): Track[] {
  return [...mockLibrary];
}

export function deleteMockTrack(trackId: string): boolean {
  const previousLength = mockLibrary.length;
  mockLibrary = mockLibrary.filter((track) => track.id !== trackId);
  return mockLibrary.length !== previousLength;
}

export function simulateLocalImport(): Track[] {
  const nextTrack = importQueue.shift();
  if (!nextTrack) {
    const timestamp = Date.now();
    const generated = makeTrack(`track-import-${timestamp}`, {
      title: `New Import ${mockLibrary.length + 1}`,
      artist: "Local Collection",
      album: "Freshly Added",
      durationSec: 180 + (mockLibrary.length % 5) * 14,
      importedAt: new Date().toISOString(),
      source: "local",
    });
    mockLibrary = dedupeTracks([generated, ...mockLibrary]);
    return [generated];
  }

  mockLibrary = dedupeTracks([nextTrack, ...mockLibrary]);
  return [nextTrack];
}

export function searchMockLyrics(track: Track): LyricsLine[] {
  const existing = mockLibrary.find((item) => item.id === track.id)?.lyrics;
  if (existing?.length) {
    return existing;
  }

  return makeLyrics([
    [0, `${track.title} begins in a soft room`],
    [14, `A simple pulse follows ${track.artist}`],
    [34, "Night windows breathe in rhythm"],
    [57, "The chorus keeps a steady glow"],
    [82, "Every echo lands a little closer"],
    [110, `And ${track.title} settles in the air`],
  ]);
}

export function searchMockVideos(query: string): YouTubeVideo[] {
  const normalized = query.trim() || "music";
  const titleSeed = normalized
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");

  return [
    {
      id: `yt-${titleSeed.toLowerCase().replace(/\s+/g, "-")}-session`,
      title: `${titleSeed} Session`,
      channel: "musicx Studio",
      durationSec: 228,
      description: "Live room session with clean stereo audio.",
    },
    {
      id: `yt-${titleSeed.toLowerCase().replace(/\s+/g, "-")}-official`,
      title: `${titleSeed} Official Audio`,
      channel: "North Arcade Archive",
      durationSec: 214,
      description: "Official upload prepared for audio extraction.",
    },
    {
      id: `yt-${titleSeed.toLowerCase().replace(/\s+/g, "-")}-acoustic`,
      title: `${titleSeed} Acoustic Cut`,
      channel: "Harbor Radio",
      durationSec: 197,
      description: "Acoustic performance recorded in a small studio.",
    },
  ];
}

export function simulateDownloadedTrack(video: YouTubeVideo): Track {
  const track = makeTrack(`track-${video.id}`, {
    title: video.title,
    artist: video.channel,
    album: "YouTube Imports",
    durationSec: video.durationSec,
    importedAt: new Date().toISOString(),
    youtubeId: video.id,
    source: "youtube",
  });

  mockLibrary = dedupeTracks([track, ...mockLibrary]);
  return track;
}

export function buildMockDownloadSequence(
  video: YouTubeVideo,
): DownloadProgress[] {
  return [
    {
      videoId: video.id,
      title: video.title,
      phase: "queued",
      progress: 6,
      message: "Queued for download",
    },
    {
      videoId: video.id,
      title: video.title,
      phase: "searching",
      progress: 18,
      message: "Preparing stream information",
    },
    {
      videoId: video.id,
      title: video.title,
      phase: "downloading",
      progress: 54,
      message: "Downloading audio stream",
    },
    {
      videoId: video.id,
      title: video.title,
      phase: "converting",
      progress: 82,
      message: "Converting to MP3",
    },
    {
      videoId: video.id,
      title: video.title,
      phase: "writing",
      progress: 95,
      message: "Writing track to library",
    },
    {
      videoId: video.id,
      title: video.title,
      phase: "done",
      progress: 100,
      message: "Download complete",
    },
  ];
}
