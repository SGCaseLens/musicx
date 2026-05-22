# musicx Product And Implementation Requirements

This document is a rebuild-level specification for `musicx`. It is written so another AI coding tool, such as Codex, Claude Code, Cursor, or a similar agent, can recreate the same app from an empty directory.

## 1. Product Summary

Build `musicx`, a local-first macOS desktop music player using Tauri 2, React 19, TypeScript, Vite, and Rust.

The app must let users:

- Import local audio into an app-managed library.
- Search YouTube videos.
- Download YouTube audio as local MP3 files.
- Attach and synchronize lyrics from local files, embedded metadata, YouTube subtitles, and remote lyric search.
- Manage a real local music library with favorites, recent plays, persistent queue, sorting, and right-click row actions.
- Play a complete local library with polished macOS-style controls.
- Manage playback, lyrics, downloads, language, and library search from one friendly interface.

The final app must feel like a refined macOS music desk inspired by Wake Music-style visual hierarchy: soft glass surfaces, rounded cards, a focused center player, expressive turntable artwork, calm warm accents, and no generic boilerplate layout.

## 2. App Identity

Use these exact identifiers:

| Field | Value |
| --- | --- |
| Product name | `musicx` |
| Package name | `musicx` |
| Rust package name | `musicx` |
| Rust library crate | `musicx_lib` |
| Tauri bundle identifier | `com.musicx` |
| Version | `0.2.0` |
| Main window title | `musicx` |
| Primary target | macOS arm64 desktop |

The app can include a browser-only demo mode for frontend development, but the shipped product is a Tauri desktop app.

## 3. Technology Requirements

### Frontend

- React `^19.1.0`.
- TypeScript `~5.8.3`.
- Vite `^7.0.4`.
- Tauri JS API `^2`.
- Tauri dialog plugin `^2.7.0`.
- Tauri opener plugin `^2`.
- `i18next`, `react-i18next`, `lucide-react`, `clsx`, and `zustand`.
- Use modern React patterns already present in the app, including `useEffectEvent`, `startTransition`, and `useDeferredValue`.

### Backend

- Rust 2021 edition.
- Tauri 2.
- SQLite through `rusqlite` with the `bundled` feature.
- Async runtime through Tokio.
- Metadata extraction through `lofty`.
- HTTP through `reqwest` with `rustls-tls`.
- File name sanitization through `sanitize-filename`.
- YouTube and audio conversion integration through `yt-dlp` and `ffmpeg`.
- `ffmpeg-sidecar` is allowed for ffmpeg location/download fallback.

### Project Scripts

`package.json` must define:

```json
{
  "dev": "vite",
  "build": "tsc && vite build",
  "test": "pnpm build && pnpm test:ui && cargo test --manifest-path src-tauri/Cargo.toml",
  "test:ui": "vitest run",
  "test:rust": "cargo test --manifest-path src-tauri/Cargo.toml",
  "preview": "vite preview",
  "tauri": "tauri"
}
```

## 4. Tauri Configuration

`src-tauri/tauri.conf.json` must include:

- `productName`: `musicx`
- `version`: `0.2.0`
- `identifier`: `com.musicx`
- `beforeDevCommand`: `pnpm dev`
- `devUrl`: `http://localhost:1420`
- `beforeBuildCommand`: `pnpm build`
- `frontendDist`: `../dist`
- Main window:
  - `title`: `musicx`
  - `width`: `1100`
  - `height`: `760`
  - `minWidth`: `900`
  - `minHeight`: `640`
- Security:
  - `csp`: `null`
  - Asset protocol enabled.
  - Asset protocol scope limited to `$APPLOCALDATA/**`.
- Bundle:
  - Active.
  - Target all configured Tauri targets.
  - External binary: `binaries/ffmpeg`.
  - Icons include `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, and `icon.ico`.

## 5. File And Module Layout

The finished project must use this structure:

```text
src/
  App.tsx
  App.css
  main.tsx
  i18n.ts
  types.ts
  components/
    DownloadPanel.tsx
    DownloadPanel.test.tsx
    LyricsPanel.tsx
    LyricsPanel.test.tsx
    NowPlayingCard.tsx
    TrackList.tsx
    YouTubePanel.tsx
  hooks/
    useArtworkAccent.ts
    useAudioMeter.ts
    useAudioPlayer.ts
  lib/
    format.ts
    lyrics.ts
    lyrics.test.ts
    mockData.ts
    tauri.ts
  test/
    setup.ts
vitest.config.ts
src-tauri/
  tauri.conf.json
  Cargo.toml
  build.rs
  binaries/
    ffmpeg-aarch64-apple-darwin
  capabilities/
    default.json
  icons/
  src/
    binaries.rs
    demo.rs
    errors.rs
    lib.rs
    library.rs
    lyrics.rs
    main.rs
    paths.rs
    state.rs
    subtitles.rs
    system_volume.rs
    types.rs
    youtube.rs
```

## 6. Data Storage Requirements

Use Tauri's app-local data directory for `com.musicx`.

Create these paths at startup:

| Path | Purpose |
| --- | --- |
| root | App-local data root |
| `library/` | Copied imported audio and downloaded YouTube MP3s |
| `artwork/` | Extracted embedded artwork and YouTube thumbnails |
| `bin/` | Runtime helper binaries such as downloaded `yt-dlp` |
| `tmp/` | Temporary YouTube download jobs |
| `musicx.sqlite3` | SQLite library database |

Implement a compatibility migration from a temporary rename experiment:

- If a sibling app data folder named `com.cantodeck` exists.
- If the current `com.musicx` data root does not already contain `musicx.sqlite3`.
- Copy or rename data from `com.cantodeck` into `com.musicx`.
- Rename `cantodeck.sqlite3` to `musicx.sqlite3`.

## 7. SQLite Schema

Create a `tracks` table:

```sql
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  duration_ms INTEGER NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  original_path TEXT,
  cover_art_path TEXT,
  language TEXT,
  youtube_video_id TEXT,
  youtube_url TEXT,
  lyrics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_updated_at ON tracks(updated_at DESC);
```

Rows must be ordered by `updated_at DESC, title COLLATE NOCASE ASC`.

Store lyrics as serialized JSON using the `LyricsDocument` shape defined below.

## 8. Backend Data Types

### LyricLine

```rust
struct LyricLine {
  start_ms: i64,
  end_ms: Option<i64>,
  text: String,
  secondary_text: Option<String>,
  confidence: f32,
}
```

### LyricsDocument

```rust
struct LyricsDocument {
  source_kind: String,
  provider: String,
  lang: Option<String>,
  raw_text: Option<String>,
  is_synced: bool,
  confidence: f32,
  source_duration_ms: Option<i64>,
  global_offset_ms: i64,
  lines: Vec<LyricLine>,
}
```

### Track

```rust
struct Track {
  id: String,
  source_kind: String,
  title: String,
  artist: String,
  album: Option<String>,
  duration_ms: i64,
  file_path: String,
  original_path: Option<String>,
  cover_art_path: Option<String>,
  language: Option<String>,
  youtube_video_id: Option<String>,
  youtube_url: Option<String>,
  lyrics: Option<LyricsDocument>,
  created_at: String,
  updated_at: String,
}
```

Use camelCase serialization for Tauri command payloads.

## 9. Tauri Commands

Expose these commands:

| Command | Purpose |
| --- | --- |
| `bootstrap_app` | Ensure app directories, open/init SQLite, detect locale, prepare dependency status. |
| `list_tracks` | Return all database tracks plus the built-in demo track when missing. |
| `import_local_tracks` | Import one or more local audio files. |
| `delete_track` | Delete a non-demo track from SQLite and remove managed files safely. |
| `search_lyrics_for_track` | Search remote lyrics for a track that does not already have lyrics. |
| `search_youtube_videos` | Search YouTube with `yt-dlp` and return video results. |
| `download_youtube_audio` | Download a YouTube video as MP3, save it, attach lyrics/artwork, and return the track. |
| `get_system_output_volume` | Read macOS output volume as a `0.0..1.0` fraction. |
| `set_system_output_volume` | Set macOS output volume from a `0.0..1.0` fraction. |
| `open_library_folder` | Open the app-managed library folder in Finder without accepting an arbitrary frontend path. |

Emit the event `youtube-download-progress` during downloads.

Progress payloads must include:

- `taskId`
- `videoId`
- `stage`
- `progress`
- `message`
- Optional `track`

## 10. Startup Requirements

On startup:

1. Render immediately with a usable frontend shell.
2. Try `list_tracks` first so existing tracks appear quickly.
3. Run `bootstrap_app`.
4. Ensure directories and SQLite exist.
5. Prepare dependency readiness flags for `yt-dlp` and `ffmpeg`.
6. Detect system locale through `sys_locale`.
7. Merge bootstrap/listed tracks without duplicates.
8. Select the first available track automatically.
9. If no database track with id `demo-sunrise-circuit` exists, insert a built-in in-memory demo track into the returned list.

## 11. Built-In Demo Track

Provide a demo track:

- ID: `demo-sunrise-circuit`
- Title: `Sunrise Circuit`
- Artist: `musicx demo ensemble`
- Album: `Built-in Examples`
- Source kind: `demo`
- Duration: generated from a 48-note melody.
- Audio file: `musicx-demo-sunrise-circuit.wav` under `library/`.
- Artwork: `musicx-demo-cover.png` under `artwork/`.
- Lyrics: eight synced English lines with Chinese secondary text.

Generate the WAV file programmatically if missing. The demo track must not be deletable.

## 12. Local Import Requirements

The Import button text may say `Import MP3`, but the file picker must accept:

- `mp3`
- `m4a`
- `wav`
- `flac`
- `aac`
- `ogg`

For each selected file:

1. Skip missing files and unsupported extensions.
2. Deduplicate by `original_path` or existing managed `file_path`.
3. Read metadata using `lofty`.
4. Use metadata title, artist, album, duration, embedded artwork, and embedded lyrics when present.
5. Fall back to the file stem for title and `Unknown Artist` for artist.
6. Compute a lightweight file signature from file size plus head/tail Blake3 hash.
7. Copy the source file into `library/` using a sanitized name containing the title and first eight chars of the UUID.
8. Extract embedded artwork into `artwork/` using a safe inferred extension.
9. Search sidecar lyrics next to the original file with `.lrc`, `.txt`, `.vtt`, `.srt`.
10. If sidecar and embedded lyrics are absent, search LRCLIB by title, artist, album, and duration.
11. Save the imported track in SQLite.

The import result must report `tracks`, `imported`, `skipped`, and `warnings`.

## 13. Delete Requirements

Deleting a track must:

- Reject the built-in demo track.
- Delete the database row.
- Remove the managed audio file only if it is inside the app `library/` directory.
- Remove managed artwork only if it is inside the app `artwork/` directory.
- Never delete the original source file outside the app library.
- Return warnings if file cleanup is skipped or fails.

## 14. Lyrics Requirements

Support these lyric sources:

| Source | Behavior |
| --- | --- |
| Sidecar `.lrc` | Parse timed LRC. |
| Sidecar `.vtt` | Parse WebVTT captions. |
| Sidecar `.srt` | Parse SRT captions. |
| Sidecar `.txt` | Parse as plain text fallback. |
| Embedded metadata | Parse embedded text from audio tags. |
| YouTube subtitles | Parse as timed captions only; do not collapse raw VTT into one plain text line. |
| LRCLIB | Prefer synced lyrics, then plain lyrics. |
| Demo | Built-in synced bilingual lyric lines. |

### LRC Parsing

- Support multiple timestamps per line.
- Support `[offset:+/-ms]`.
- Accept `mm:ss.xx`, `mm:ss.xxx`, and similar fractions.
- Sort lines by start time.
- Fill missing `end_ms` from the next line or track duration.

### VTT/SRT Parsing

- Detect cue arrows.
- Support cue settings after the end timestamp, such as `align:start position:0%`.
- Ignore metadata lines such as `WEBVTT`, `STYLE`, `REGION`, `NOTE`, `Kind:`, and `Language:`.
- Strip inline YouTube timing tags like `<00:00:59.359>`.
- Strip caption markup tags.
- Decode common entities including `&amp;`, `&nbsp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;`.
- Do not fail an entire caption document because one cue is malformed.

### Plain Text

Plain text is allowed for local or remote non-subtitle lyrics. It must create one line starting at `0` and ending at the track duration if known.

YouTube subtitles must not fall back to plain text, because that produces unsynced raw `WEBVTT` text.

### Repair

When listing tracks, detect stored lyric documents whose `raw_text` is timed text but whose lines were previously stored incorrectly. Re-parse and repair them in SQLite.

### Lyric Offset

- Store a per-track `global_offset_ms` in the lyrics JSON.
- Expose a Tauri command to update the offset and persist it in SQLite.
- Clamp offset writes to `-30000..30000` milliseconds on both frontend and backend.
- Apply the offset during active lyric lookup without mutating individual lyric timestamps.
- Positive offsets delay lyric highlighting; negative offsets move lyrics earlier.
- Provide UI controls for `-0.5s`, reset, and `+0.5s`.

### Remote Search

Use LRCLIB:

- First call `/api/get` with track name and artist, plus album/duration when available.
- If no exact match, call `/api/search`.
- Score candidates by normalized title, artist, album, and duration.
- Accept candidates with score at least `0.45`.
- Use an eight-second HTTP timeout.
- Use user agent `musicx/0.1`.
- Infer language from lyric content: CJK implies `zh-CN`, otherwise `en`.

## 15. YouTube Search Requirements

Use `yt-dlp` for YouTube search.

Preparation order:

1. Existing app-data binary.
2. `yt-dlp` from `PATH`.
3. `python3 -m yt_dlp`.
4. Download official standalone binary into app data.

On macOS, download `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos`.

Search behavior:

- Accept non-empty query only.
- Clamp UI/backend limit to `1..20`; frontend uses 10.
- Request twice the UI limit, clamped up to 40, to compensate for filtered entries.
- Use `ytsearch{n}:{query}`.
- Try `--dump-single-json` first.
- Fall back to line-delimited `--dump-json`.
- Use `--flat-playlist`, `--skip-download`, `--no-warnings`, `--ignore-errors`, extractor retries of 3, and socket timeout of 20.
- Filter only YouTube video entries with valid 11-character video IDs.
- Return id, title, channel/uploader, duration in milliseconds, best thumbnail, and webpage URL.
- If search fails, refresh `yt-dlp` and retry once.

## 16. YouTube Download Requirements

Only support YouTube video IDs or YouTube video URLs. Reject non-YouTube URLs.

Only one download per video identity should run at a time.

The frontend should retry recoverable failures up to three attempts before showing a manual retry action. Recoverable failures include HTTP 429 rate limits, timeouts, transient network errors, unavailable responses, and connection resets. The active download lock must remain held until the command finishes or fails, so automatic retry windows cannot create overlapping downloads.

Download flow:

1. Resolve the video identity.
2. Fetch metadata with `yt-dlp --dump-single-json --skip-download --no-playlist --no-warnings`.
3. Create a temp job directory under `tmp/youtube-{video}-{task}`.
4. Emit progress event `prepare` at `0.01`.
5. Run `yt-dlp` to download audio and convert to MP3.
6. Capture stdout for progress and final file path markers.
7. Capture the last stderr lines for useful errors.
8. Timeout the download after 20 minutes.
9. Move the final MP3 into `library/`.
10. Move generated thumbnail artwork into `artwork/`.
11. Download subtitles best-effort.
12. Parse subtitle lyrics.
13. If subtitles are missing, sparse, or music-only, search LRCLIB using inferred title/artist.
14. Clean up the temp job directory.
15. Save and return the created YouTube track.

MP3 output naming:

- Use sanitized title.
- Append the first eight characters of the YouTube video ID.
- Extension must be `.mp3`.

### Subtitle Language Preference

Prefer subtitles based on the UI locale:

- For Chinese UI, try Chinese variants before English.
- Recover from subtitle HTTP 429 errors and continue audio download.
- Treat subtitle failure as a warning, not an audio download failure.

### Metadata Inference

When YouTube metadata artist is generic or uploader-based, infer lyric lookup identity from video title. Examples:

- `Taylor Swift - Welcome To New York (Lyrics)` should infer artist `Taylor Swift`, title `Welcome To New York`.
- Remove common noise terms such as official, video, audio, lyrics, MV, live, remastered, and similar text.

## 17. Player Requirements

Use a hidden or embedded HTML audio element controlled by React.

Playback state must include:

- Current time.
- Duration.
- Is playing.
- Can play.
- Volume.
- Error.

Controls:

- Previous.
- Play/pause.
- Next.
- Seek slider with pointer down/input/up/cancel handling.
- Volume slider.
- Sequential/shuffle toggle.
- Repeat off/all/one cycle.

Playback behavior:

- When a selected track changes, stop the previous track and reset current time.
- Use a play intent guard so unexpected browser autoplay events do not create stale playback state.
- Use requestAnimationFrame while playing, syncing state at roughly 160 ms intervals.
- On ended:
  - Repeat one restarts the same track.
  - Shuffle picks a random different track when possible.
  - Repeat all wraps to the first track.
  - Sequential mode advances to the next track.
- Keep shuffle history for previous-track behavior, capped to the latest 24 entries.

## 18. Keyboard Shortcut Requirements

Implement global shortcuts:

| Shortcut | Action |
| --- | --- |
| `Space` | Toggle play/pause |
| `ArrowLeft` | Seek backward 10 seconds |
| `ArrowRight` | Seek forward 10 seconds |
| `ArrowUp` | Increase volume by 5% |
| `ArrowDown` | Decrease volume by 5% |
| `Command + O` | Open the library drawer |
| `Command + R` | Refresh the library |
| `Command + N` | Next track |
| `Command + P` | Previous track |
| `Command + S` | Switch to YouTube panel and focus/select the search field |

Do not trigger non-command shortcuts when the event target is inside `input`, `textarea`, `select`, or `[contenteditable=true]`.

## 19. macOS Volume Requirements

In desktop mode, the in-app volume slider must control macOS system output volume.

When macOS output volume changes outside the app, the app volume slider must synchronize back to the current system volume.

Use `osascript`:

- Read: `output volume of (get volume settings)`
- Write: `set volume output volume {percent}`

Clamp volume to `0.0..1.0`.

Convert fractions to rounded integer percentages.

Debounce slider writes by roughly 80 ms, except keyboard volume changes should commit immediately.

In browser demo mode, use element volume only.

## 20. UI And UX Requirements

### Visual Direction

- Use macOS system typography:
  - `-apple-system`
  - `BlinkMacSystemFont`
  - `SF Pro Text`
  - `SF Pro Display`
  - `Helvetica Neue`
  - `sans-serif`
- Use macOS-like font sizes:
  - Mini `10px`
  - Caption `11px`
  - Small `12px`
  - Body `13px`
  - Callout `14px`
  - Headline `15px`
  - Title `17px`
  - Large title `22px`
  - Hero `28px`
- Use light mode, soft glass panels, rounded corners, warm accent gradients, shadows, artwork-derived accent colors, and subtle ambient glows.
- Avoid duplicating fake macOS red/yellow/green window controls inside the web UI.

### Layout

Desktop wide layout:

- Three columns:
  - Library rail: `320px..360px`
  - Listening stage: flexible center
  - Context rail: `380px..440px`
- Full viewport height on wide screens.
- Internally scroll rails instead of stretching the whole page.

Narrow layout:

- Library rail becomes a hidden drawer opened by `Open library`.
- Context rail moves below or adapts into stacked content.
- Prevent deformation when the window is snapped to the left or right side of the screen.

Mobile-width fallback:

- Keep content usable with one-column stacking.
- Limit lyrics panel height so long lyrics do not stretch the whole page.

### Header

Show:

- App tagline: `A local-first listening desk for macOS`.
- Runtime hint and status.
- Open/Hide library button.
- Refresh button.
- Import MP3 button.
- Language switcher with `EN` and a Simplified Chinese label.

### Library Rail

Show:

- Search input with IME-safe composition handling.
- Collection title.
- Source filter tabs: `All`, `Local`, `YouTube`.
- Track list.
- Empty states.
- Stats for track count, lyric-ready count, and active downloads.
- Runtime footer `Saved library` action that opens the app-managed library folder in Finder without displaying the full filesystem path.

Track rows must show:

- Real track artwork when available, otherwise the default disc icon.
- Title with truncation and full `title` attribute.
- Artist/album metadata.
- Imported date when available.
- Source pill.
- Duration.
- Play/pause action.
- Delete action.

### Listening Stage

Show:

- Eyebrow `Listening stage`.
- Track title and artist.
- Source chip.
- Play/pause status chip.
- Turntable record with artwork or initials.
- Tonearm that animates while playing.
- Progress slider with current and total time.
- Previous/play-next controls.
- Shuffle/sequential chip.
- Repeat chip.
- Volume slider.
- Album/imported metadata.
- Signal meter with 12 bars driven by audio frequency data while playing.

### Context Rail

Tabs:

- Lyrics.
- YouTube.
- Downloads.

Lyrics panel:

- Current timeline chip.
- Source chip when available.
- Persisted lyric offset controls.
- Find lyrics button.
- Scrollable lyric list.
- Active line highlighting.
- Empty and error states.

YouTube panel:

- Search input with IME-safe composition handling.
- Search button.
- Use current track button.
- Result cards with thumbnail, title, channel, description, duration.
- Download button.
- Double-click or keyboard activate result to download, add to playlist, and auto-play.

Downloads panel:

- Progress hero.
- Spinner for active phases.
- Percent.
- Progress bar.
- Message text.
- Retry button when the final download state is an error.
- Empty state.

## 21. Internationalization Requirements

Support at least:

- English: `en`
- Simplified Chinese: `zh-CN`

Use a translation dictionary and a `createTranslator(locale)` helper.

Persisting language is optional, but the app must:

- Detect system locale during bootstrap.
- Fall back to English.
- Set `document.documentElement.lang` to the selected locale.
- Let the user switch language from the header.

All user-facing UI strings must come from the translation dictionary unless they are dynamic external data.

## 22. Browser Demo Mode

When not running under Tauri:

- Use mock tracks.
- Simulate import.
- Simulate lyrics search.
- Simulate YouTube search.
- Simulate download progress.
- Resolve no local filesystem paths.
- Show browser runtime hint.

This mode is for frontend iteration only.

## 23. macOS App Lifecycle Requirements

On macOS:

- Intercept close-requested events for the main window.
- Prevent close.
- Hide the main window.
- Keep the app running in the background.
- Reopen the main window when the Dock icon is clicked and no windows are visible.
- Let `Command + Q` quit normally through default macOS app behavior.

## 24. Security Requirements

- Limit Tauri asset protocol to `$APPLOCALDATA/**`.
- Validate YouTube URLs and video IDs.
- Reject non-YouTube download URLs.
- Sanitize filenames for imported and downloaded files.
- Do not build shell command strings; pass command arguments as arrays.
- Use safe file deletion:
  - Canonicalize target and allowed root.
  - Delete only if target starts with the allowed root.
- Avoid deleting original imported files outside the managed library.
- Clamp all user-controlled numeric volume inputs.
- Handle missing tracks and missing paths without panics.
- Store only local file paths and metadata in SQLite.

## 25. Concurrency And Reliability Requirements

- Protect active downloads with shared state so duplicate downloads for the same video do not run concurrently.
- Use request IDs to ignore stale YouTube search responses.
- Use request IDs to ignore stale volume writes.
- Clean up temp download directories after success, failure, or timeout.
- Keep the last stderr lines from `yt-dlp` to produce useful errors.
- Treat subtitle download errors as recoverable when audio has already succeeded.
- Refresh `yt-dlp` and retry when YouTube search fails.
- Avoid crashing if artwork, lyrics, metadata, subtitles, or helper binaries are unavailable.

## 26. Performance Requirements

- Use `useDeferredValue` and `startTransition` for library search and large state updates.
- Do not recompute filtered tracks unnecessarily beyond simple in-memory filtering.
- Keep queue materialization, sorting, favorites, and recent-play filtering in deterministic in-memory helpers covered by unit tests.
- Persist queue ids and sort preferences in `localStorage`, and automatically drop stale queue ids when tracks are deleted.
- Store favorite, play count, and last-played metadata in SQLite with migration-safe default columns and indexes.
- Keep lyrics inside a scroll container; long lyrics must not stretch the full page.
- Only scroll lyrics when the active lyric index changes.
- Use `requestAnimationFrame` for playback progress and audio meter updates.
- Throttle playback state synchronization to about 160 ms while playing.
- Throttle audio meter rendering to about 34 ms while playing.
- Stop animation frames when paused, ended, hidden, or unmounted.
- Close the Web Audio context on unmount.
- Use SQLite indexes for updated-at ordering.
- Avoid loading full files to compute signatures; hash only the head and tail plus file size.

## 27. Accessibility Requirements

- Use semantic buttons and form labels.
- Give icon-only buttons clear `aria-label` values.
- Use tablist/tab semantics for language, source filters, and context panels.
- Provide visible focus outlines.
- Support keyboard activation with `Enter` and `Space` for tabs/result cards.
- Provide `title` attributes for truncated long text.
- Avoid relying on color alone for status.

## 28. Release Requirements

The release build must produce:

- `src-tauri/target/release/bundle/macos/musicx.app`
- `src-tauri/target/release/bundle/dmg/musicx_0.2.0_aarch64.dmg`

The currently expected release is macOS arm64. Do not claim notarization, universal binaries, app-store distribution, auto-updates, or Windows/Linux packages unless those are added later.

## 29. Acceptance Test Checklist

Run:

```bash
pnpm build
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm tauri build
```

Manual checks:

- App launches as `musicx`.
- `Info.plist` contains `CFBundleDisplayName = musicx`, `CFBundleExecutable = musicx`, `CFBundleIdentifier = com.musicx`, version `0.2.0`.
- Built-in demo track appears and plays.
- Import opens a native file picker.
- Supported local audio imports, copies into library, and appears in the track list.
- Track delete removes the managed copy but not the original source file.
- Library search works with English and Chinese IME input.
- Library filters switch between All, Favorites, Recent, Local, and YouTube.
- Library sorting works for added date, title, artist, duration, and last-played time in ascending and descending directions.
- Favorite toggles persist after app refresh/restart.
- Recent plays update only when playback starts and persist after app refresh/restart.
- Queue actions support play next, add to queue, remove from queue, clear queue, stale-id cleanup, and persistence after app refresh/restart.
- Right-clicking a song row opens actions for play, play next, queue, favorite, and delete.
- Player play/pause works.
- Progress slider can seek to arbitrary time.
- Previous and next controls work.
- Sequential/shuffle toggle works.
- Repeat off/all/one cycle works.
- Space toggles play/pause.
- Left/right arrows seek by 10 seconds.
- Up/down arrows change volume by 5%.
- `Command + N` goes next.
- `Command + P` goes previous.
- `Command + S` focuses YouTube search.
- `Command + O` opens the library drawer.
- `Command + R` refreshes the library.
- Volume slider changes macOS output volume in desktop mode.
- macOS volume changes outside the app sync back into the app volume slider.
- Long lyrics scroll inside the lyrics panel without shaking or stretching the main UI.
- Active lyrics match playback time for VTT/SRT/LRC inputs.
- Lyric offset buttons move active lyric highlighting by 0.5 second steps and persist after refresh.
- YouTube search accepts Chinese and English queries.
- YouTube result double-click downloads, adds to library, and auto-plays after completion.
- YouTube subtitle 429 warnings do not fail an otherwise successful audio download.
- Recoverable YouTube download failures retry automatically, then expose a manual retry button if all attempts fail.
- YouTube downloads save MP3 files into the app library.
- App close button hides the window instead of quitting on macOS.
- Dock reopen shows and focuses the main window.
- `Command + Q` quits.

## 30. Required Unit Test Coverage

At minimum, include Rust unit tests for:

- yt-dlp macOS binary selection.
- ffmpeg executable naming.
- YouTube video ID extraction.
- Supported and unsupported YouTube URL validation.
- Download identity preference.
- Search JSON parsing and filtering.
- Search result URL normalization.
- Subtitle 429 recoverability.
- Audio download error non-recoverability.
- Audio download args excluding subtitle flags.
- Subtitle download args containing only subtitle flags.
- Chinese subtitle preference order.
- Lyrics-only fallback for sparse/music-only subtitles.
- YouTube title parsing for artist/title inference.
- LRC parsing.
- VTT parsing.
- YouTube VTT cue settings and inline tag parsing.
- Remote-subtitle documents not falling back to raw plain text.
- Repairing stored raw timed-text lyrics.
- Lyric offset persistence and backend clamping.
- Delete record success and missing no-op.
- Favorite and recent-play metadata persistence.
- Demo track asset generation.
- macOS volume conversion and parsing.
- Temporary `com.cantodeck` data migration back to `com.musicx`.

At minimum, include Vitest UI/unit tests for:

- Active lyric lookup with a non-zero lyric offset.
- Lyric offset button callbacks.
- WebVTT parsing into separate timed lines.
- Download error retry action rendering and click handling.
- Library sorting, queue dedupe, queue materialization, and stale track cleanup.
- Track row favorite, queue, remove-queue, and context-menu entry points.

## 31. Known Constraints

- YouTube search and download depend on `yt-dlp`, network access, and YouTube behavior.
- Lyrics lookup depends on LRCLIB availability and track metadata quality.
- System volume control is macOS-specific.
- Current release artifacts are local macOS arm64 builds and are not notarized.
- There is no CI configuration in the current implementation.
