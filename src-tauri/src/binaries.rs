use crate::paths::ensure_app_dirs;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone)]
pub struct BinaryCommand {
    pub program: PathBuf,
    pub prefix_args: Vec<String>,
    pub display_name: String,
}

impl BinaryCommand {
    pub fn command(&self) -> TokioCommand {
        let mut command = TokioCommand::new(&self.program);
        command.args(&self.prefix_args);
        command
    }
}

pub async fn ensure_yt_dlp(app: &AppHandle) -> Result<BinaryCommand> {
    let app_paths = ensure_app_dirs(app)?;
    let target = app_paths.bin.join(yt_dlp_filename());
    if command_works(target.as_os_str(), &["--version"]) {
        return Ok(BinaryCommand {
            program: target.clone(),
            prefix_args: Vec::new(),
            display_name: target.to_string_lossy().to_string(),
        });
    }

    if command_works("yt-dlp", &["--version"]) {
        return Ok(BinaryCommand {
            program: PathBuf::from("yt-dlp"),
            prefix_args: Vec::new(),
            display_name: "yt-dlp".to_string(),
        });
    }

    if command_works("python3", &["-m", "yt_dlp", "--version"]) {
        return Ok(BinaryCommand {
            program: PathBuf::from("python3"),
            prefix_args: vec!["-m".to_string(), "yt_dlp".to_string()],
            display_name: "python3 -m yt_dlp".to_string(),
        });
    }

    download_yt_dlp(&target).await?;
    Ok(BinaryCommand {
        program: target.clone(),
        prefix_args: Vec::new(),
        display_name: target.to_string_lossy().to_string(),
    })
}

pub async fn refresh_yt_dlp(app: &AppHandle) -> Result<BinaryCommand> {
    let app_paths = ensure_app_dirs(app)?;
    let target = app_paths.bin.join(yt_dlp_filename());

    download_yt_dlp(&target).await?;

    Ok(BinaryCommand {
        program: target.clone(),
        prefix_args: Vec::new(),
        display_name: target.to_string_lossy().to_string(),
    })
}

pub async fn ensure_ffmpeg(app: &AppHandle) -> Result<BinaryCommand> {
    let app_paths = ensure_app_dirs(app)?;
    let mut candidates = vec![
        app_paths.bin.join(ffmpeg_filename()),
        ffmpeg_sidecar::paths::ffmpeg_path(),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(ffmpeg_filename()));
        }
    }

    for candidate in candidates {
        if command_works(candidate.as_os_str(), &["-version"]) {
            return Ok(BinaryCommand {
                program: candidate.clone(),
                prefix_args: Vec::new(),
                display_name: candidate.to_string_lossy().to_string(),
            });
        }
    }

    for program in [
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        if command_works(program, &["-version"]) {
            return Ok(BinaryCommand {
                program: PathBuf::from(program),
                prefix_args: Vec::new(),
                display_name: program.to_string(),
            });
        }
    }

    if sidecar_download_dir_is_writable() {
        tauri::async_runtime::spawn_blocking(ffmpeg_sidecar::download::auto_download)
            .await
            .context("failed to join ffmpeg downloader task")??;

        let path = ffmpeg_sidecar::paths::ffmpeg_path();
        if command_works(path.as_os_str(), &["-version"]) {
            return Ok(BinaryCommand {
                program: path.clone(),
                prefix_args: Vec::new(),
                display_name: path.to_string_lossy().to_string(),
            });
        }
    }

    anyhow::bail!(
        "ffmpeg is not available. Please use the bundled musicx.app build or install ffmpeg with Homebrew."
    )
}

async fn download_yt_dlp(target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .context("failed to create yt-dlp downloader")?;
    let response = timeout(
        Duration::from_secs(60),
        client.get(yt_dlp_download_url()).send(),
    )
    .await
    .context("yt-dlp download timed out")?
    .context("failed to download yt-dlp")?
    .error_for_status()
    .context("yt-dlp download returned an error response")?;
    let bytes = response
        .bytes()
        .await
        .context("failed to read yt-dlp bytes")?;

    tokio::fs::write(target, bytes.as_ref())
        .await
        .with_context(|| format!("failed to write {}", target.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = std::fs::Permissions::from_mode(0o755);
        tokio::fs::set_permissions(target, permissions)
            .await
            .with_context(|| format!("failed to mark {} as executable", target.display()))?;
    }

    Ok(())
}

fn yt_dlp_download_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"
    } else if cfg!(target_os = "linux") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
    } else {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
    }
}

fn yt_dlp_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "yt-dlp_linux_aarch64"
    } else if cfg!(target_os = "linux") {
        "yt-dlp_linux"
    } else {
        "yt-dlp"
    }
}

fn ffmpeg_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn sidecar_download_dir_is_writable() -> bool {
    let Ok(dir) = ffmpeg_sidecar::paths::sidecar_dir() else {
        return false;
    };
    let probe = dir.join(".musicx-ffmpeg-write-test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

fn command_works(program: impl AsRef<std::ffi::OsStr>, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{ffmpeg_filename, yt_dlp_download_url, yt_dlp_filename};

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_uses_standalone_yt_dlp_binary() {
        assert!(yt_dlp_download_url().ends_with("/yt-dlp_macos"));
        assert_eq!(yt_dlp_filename(), "yt-dlp_macos");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_uses_exe_yt_dlp_binary() {
        assert!(yt_dlp_download_url().ends_with("/yt-dlp.exe"));
        assert_eq!(yt_dlp_filename(), "yt-dlp.exe");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_uses_unix_ffmpeg_name() {
        assert_eq!(ffmpeg_filename(), "ffmpeg");
    }
}
