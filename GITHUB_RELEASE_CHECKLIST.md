# GitHub Release Checklist

Use this checklist before pushing `musicx` to GitHub.

## Repository Hygiene

The repository should include source code, lockfiles, Tauri configuration, icons, documentation, and the app-specific Rust/TypeScript implementation.

Do not commit:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- packaged release artifacts such as `.app` and `.dmg`
- local SQLite databases
- imported or downloaded music files
- local lyrics sidecars
- logs, `.env` files, private keys, certificates, or editor state

## Large Binary Policy

`src-tauri/binaries/ffmpeg-aarch64-apple-darwin` is currently required by the Tauri `externalBin` configuration for local macOS arm64 packaging. The file is about 49 MB, and `.gitignore` excludes it by default so it is not accidentally committed as a normal Git blob.

Recommended GitHub approach:

```bash
brew install git-lfs
git lfs install
git lfs track "src-tauri/binaries/ffmpeg-aarch64-apple-darwin"
git add .gitattributes
git add -f src-tauri/binaries/ffmpeg-aarch64-apple-darwin
```

Alternative approach:

- Do not commit the ffmpeg binary.
- Keep it in release assets or a private artifact store.
- Document a setup step that downloads or copies it to `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` before `pnpm tauri build`.

## Pre-Push Validation

Run these commands before the first push:

```bash
pnpm install
pnpm build
pnpm test
cd src-tauri
cargo clippy -- -D warnings
cd ..
pnpm tauri build
```

Expected local release artifacts:

- `src-tauri/target/release/bundle/macos/musicx.app`
- `src-tauri/target/release/bundle/dmg/musicx_0.1.4_aarch64.dmg`

Release artifacts are build outputs and should not be committed to Git.

## Initial GitHub Push

After deciding how to handle the ffmpeg binary, initialize and push:

```bash
git init
git add .
git status --short
git commit -m "Initial musicx app release"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

If using HTTPS instead of SSH:

```bash
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

## GitHub Repository Settings

Recommended settings:

- Add a repository description: `Local-first macOS music player built with Tauri, React, and Rust.`
- Add topics: `tauri`, `react`, `rust`, `music-player`, `macos`, `youtube-dl`, `lyrics`.
- Enable GitHub secret scanning.
- Protect the `main` branch after the first push.
- Add CI later for `pnpm build`, `cargo test`, and `cargo clippy`.

## Release Notes Template

```markdown
## musicx 0.1.4

### Highlights

- Local library import and managed storage.
- YouTube search and MP3 download.
- Synced lyrics from sidecars, subtitles, metadata, and LRCLIB, with persisted lyric offset tuning.
- Full playback controls, shortcuts, shuffle/repeat, and macOS volume integration.
- Music-reactive Signal meter and recoverable download retry UX.
- Friendly macOS-focused listening stage UI.

### Known Limitations

- macOS arm64 is the current supported release target.
- The app is not notarized.
- YouTube behavior depends on network access, YouTube availability, and `yt-dlp`.
- The bundled ffmpeg sidecar must be handled through Git LFS or another binary provisioning strategy.
```
