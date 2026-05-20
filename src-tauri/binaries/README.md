# Binary Sidecars

This directory is reserved for Tauri external binaries.

The local macOS arm64 package expects:

```text
ffmpeg-aarch64-apple-darwin
```

Do not commit large binary sidecars as normal Git blobs. Use one of these approaches before pushing to GitHub:

- Track `ffmpeg-aarch64-apple-darwin` with Git LFS.
- Store the binary as a release artifact or private build artifact.
- Copy or download a compatible ffmpeg binary into this directory before running `pnpm tauri build`.

For local development on macOS arm64, the expected path is:

```text
src-tauri/binaries/ffmpeg-aarch64-apple-darwin
```

