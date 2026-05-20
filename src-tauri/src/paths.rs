use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const CURRENT_DB_FILE: &str = "musicx.sqlite3";
const TEMP_RENAME_DB_FILE: &str = "cantodeck.sqlite3";
const TEMP_RENAME_APP_DIR: &str = "com.cantodeck";

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub library: PathBuf,
    pub artwork: PathBuf,
    pub bin: PathBuf,
    pub temp: PathBuf,
    pub db: PathBuf,
}

pub fn app_paths(app: &AppHandle) -> Result<AppPaths> {
    let root = app
        .path()
        .app_local_data_dir()
        .context("failed to resolve app local data directory")?;

    Ok(AppPaths {
        library: root.join("library"),
        artwork: root.join("artwork"),
        bin: root.join("bin"),
        temp: root.join("tmp"),
        db: root.join(CURRENT_DB_FILE),
        root,
    })
}

pub fn ensure_app_dirs(app: &AppHandle) -> Result<AppPaths> {
    let paths = app_paths(app)?;
    migrate_temporary_rename_data(&paths.root)?;
    normalize_database_filename(&paths.root)?;
    std::fs::create_dir_all(&paths.root)?;
    std::fs::create_dir_all(&paths.library)?;
    std::fs::create_dir_all(&paths.artwork)?;
    std::fs::create_dir_all(&paths.bin)?;
    std::fs::create_dir_all(&paths.temp)?;
    Ok(paths)
}

fn migrate_temporary_rename_data(root: &Path) -> Result<()> {
    let Some(parent) = root.parent() else {
        return Ok(());
    };
    let temporary_root = parent.join(TEMP_RENAME_APP_DIR);
    if !temporary_root.exists() || temporary_root == root || root.join(CURRENT_DB_FILE).exists() {
        return Ok(());
    }

    if root.exists() {
        copy_dir_contents(&temporary_root, root).with_context(|| {
            format!(
                "failed to migrate temporary app data into {}",
                root.display()
            )
        })?;
        return Ok(());
    }

    match fs::rename(&temporary_root, root) {
        Ok(()) => Ok(()),
        Err(_) => copy_dir_contents(&temporary_root, root).with_context(|| {
            format!(
                "failed to migrate temporary app data into {}",
                root.display()
            )
        }),
    }
}

fn normalize_database_filename(root: &Path) -> Result<()> {
    let legacy_db = root.join(TEMP_RENAME_DB_FILE);
    let current_db = root.join(CURRENT_DB_FILE);
    if current_db.exists() || !legacy_db.exists() {
        return Ok(());
    }

    match fs::rename(&legacy_db, &current_db) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(&legacy_db, &current_db).with_context(|| {
                format!(
                    "failed to copy legacy database {} to {}",
                    legacy_db.display(),
                    current_db.display()
                )
            })?;
            let _ = fs::remove_file(&legacy_db);
            Ok(())
        }
    }
}

fn copy_dir_contents(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target).with_context(|| format!("failed to create {}", target.display()))?;

    for entry in
        fs::read_dir(source).with_context(|| format!("failed to read {}", source.display()))?
    {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            copy_dir_contents(&source_path, &target_path)?;
        } else if file_type.is_file() && !target_path.exists() {
            fs::copy(&source_path, &target_path).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate_temporary_rename_data, normalize_database_filename};
    use std::fs;

    #[test]
    fn migrates_temporary_cantodeck_data_back_to_musicx() {
        let temp = tempfile::tempdir().expect("tempdir");
        let temporary_root = temp.path().join("com.cantodeck");
        let musicx_root = temp.path().join("com.musicx");
        fs::create_dir_all(temporary_root.join("library")).expect("temporary dirs");
        fs::write(temporary_root.join("cantodeck.sqlite3"), b"db").expect("temporary db");
        fs::write(temporary_root.join("library/song.mp3"), b"audio").expect("temporary song");

        migrate_temporary_rename_data(&musicx_root).expect("migration");
        normalize_database_filename(&musicx_root).expect("db rename");

        assert!(musicx_root.join("musicx.sqlite3").exists());
        assert!(!musicx_root.join("cantodeck.sqlite3").exists());
        assert!(musicx_root.join("library/song.mp3").exists());
    }
}
