use anyhow::{anyhow, Context, Result};

#[cfg(target_os = "macos")]
use tokio::process::Command;

pub fn clamp_volume_fraction(volume: f64) -> f64 {
    if !volume.is_finite() {
        return 0.0;
    }

    volume.clamp(0.0, 1.0)
}

pub fn volume_fraction_to_percent(volume: f64) -> u8 {
    (clamp_volume_fraction(volume) * 100.0).round() as u8
}

fn parse_output_volume(stdout: &[u8]) -> Result<f64> {
    let raw = std::str::from_utf8(stdout)
        .context("system volume output was not utf-8")?
        .trim();
    let percent = raw
        .parse::<f64>()
        .with_context(|| format!("couldn't parse system volume value: {raw}"))?;

    Ok(clamp_volume_fraction(percent / 100.0))
}

fn command_failure_message(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    "osascript exited without details".to_string()
}

#[cfg(target_os = "macos")]
pub async fn get_output_volume() -> Result<f64> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg("output volume of (get volume settings)")
        .output()
        .await
        .context("failed to read macOS output volume")?;

    if !output.status.success() {
        return Err(anyhow!(
            "couldn't read macOS output volume: {}",
            command_failure_message(&output.stderr, &output.stdout)
        ));
    }

    parse_output_volume(&output.stdout)
}

#[cfg(not(target_os = "macos"))]
pub async fn get_output_volume() -> Result<f64> {
    Err(anyhow!("system volume control is only supported on macOS"))
}

#[cfg(target_os = "macos")]
pub async fn set_output_volume(volume: f64) -> Result<f64> {
    let percent = volume_fraction_to_percent(volume);
    let script = format!("set volume output volume {percent}");
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .context("failed to set macOS output volume")?;

    if !output.status.success() {
        return Err(anyhow!(
            "couldn't set macOS output volume: {}",
            command_failure_message(&output.stderr, &output.stdout)
        ));
    }

    Ok(f64::from(percent) / 100.0)
}

#[cfg(not(target_os = "macos"))]
pub async fn set_output_volume(_volume: f64) -> Result<f64> {
    Err(anyhow!("system volume control is only supported on macOS"))
}

#[cfg(test)]
mod tests {
    use super::{clamp_volume_fraction, parse_output_volume, volume_fraction_to_percent};

    #[test]
    fn clamps_invalid_and_out_of_range_volume() {
        assert_eq!(clamp_volume_fraction(f64::NAN), 0.0);
        assert_eq!(clamp_volume_fraction(-0.4), 0.0);
        assert_eq!(clamp_volume_fraction(1.7), 1.0);
        assert_eq!(clamp_volume_fraction(0.42), 0.42);
    }

    #[test]
    fn converts_fraction_to_rounded_percent() {
        assert_eq!(volume_fraction_to_percent(-1.0), 0);
        assert_eq!(volume_fraction_to_percent(0.054), 5);
        assert_eq!(volume_fraction_to_percent(0.055), 6);
        assert_eq!(volume_fraction_to_percent(1.4), 100);
    }

    #[test]
    fn parses_osascript_output_volume() {
        assert_eq!(parse_output_volume(b"67\n").expect("volume"), 0.67);
        assert_eq!(parse_output_volume(b"125\n").expect("volume"), 1.0);
    }

    #[test]
    fn rejects_invalid_osascript_output_volume() {
        assert!(parse_output_volume(b"not-a-number\n").is_err());
    }
}
