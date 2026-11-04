// Where the library lives. The app is portable: by default its library and its
// settings sit in the folder the app itself is in (next to the .exe, the .app
// or the AppImage), so the whole thing can live on a USB stick or in a synced
// folder. Where that folder cannot be written (Program Files, a read-only
// disk, macOS running a downloaded app from a temporary copy), they fall back
// to the system's app data folder. The library can be moved anywhere from
// Settings; the choice is kept in settings.json.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const LIBRARY_NAME: &str = "Gus Gus Goose Library";
const SETTINGS_NAME: &str = "Gus Gus Goose settings.json";

#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// a folder chosen in Settings; none means the default
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_dir: Option<String>,
}

/// The library folder in use, worked out once and changed by Settings.
#[derive(Default)]
pub struct Place(pub Mutex<Option<PathBuf>>);

/// The folder the app sits in: the AppImage's folder, the folder holding the
/// .app on macOS, else the executable's own folder.
pub fn app_folder() -> Option<PathBuf> {
    if let Some(image) = std::env::var_os("APPIMAGE") {
        return PathBuf::from(image).parent().map(Path::to_path_buf);
    }
    let exe = std::env::current_exe().ok()?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let dir = exe.parent()?.to_path_buf();
    // …/Name.app/Contents/MacOS/binary → the folder that holds Name.app
    if dir.ends_with("Contents/MacOS") {
        let app = dir.parent()?.parent()?;
        if app.extension().is_some_and(|e| e == "app") {
            return app.parent().map(Path::to_path_buf);
        }
    }
    Some(dir)
}

/// True when files can be made in `dir` (made first if missing).
pub fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".gusgus-write-test");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// Where portable files go: the app's folder when it can be written, else the app data folder.
fn home(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    if let Some(dir) = app_folder() {
        // a probe in the folder itself, not a library inside it, so nothing is left behind when it fails
        let probe = dir.join(".gusgus-write-test");
        if fs::write(&probe, b"ok").is_ok() {
            let _ = fs::remove_file(&probe);
            return Ok((dir, true));
        }
    }
    let data = app.path().app_data_dir().map_err(|e| format!("no app data folder: {e}"))?;
    fs::create_dir_all(&data).map_err(|e| format!("cannot make {}: {e}", data.display()))?;
    Ok((data, false))
}

/// The default library: "Gus Gus Goose Library" next to the app, or in the app data folder.
pub fn default_library(app: &AppHandle) -> Result<(PathBuf, bool), String> {
    let (dir, portable) = home(app)?;
    Ok((dir.join(LIBRARY_NAME), portable))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home(app)?.0.join(SETTINGS_NAME))
}

pub fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn write_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = settings_path(app)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))
}

/// The library folder in use, made on first use: the one chosen in Settings
/// while it can be written, else the default.
pub fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let place = app.state::<Place>();
    let mut cur = place.0.lock().map_err(|_| "library lock poisoned")?;
    if let Some(p) = cur.as_ref() {
        if p.is_dir() {
            return Ok(p.clone());
        }
    }
    let chosen = read_settings(app).library_dir.map(PathBuf::from).filter(|p| writable(p));
    let root = match chosen {
        Some(p) => p,
        None => default_library(app)?.0,
    };
    fs::create_dir_all(&root).map_err(|e| format!("cannot make {}: {e}", root.display()))?;
    *cur = Some(root.clone());
    Ok(root)
}

/// One folder inside the other, either way round (moving a library into itself never ends).
pub fn nested(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a.starts_with(&b) || b.starts_with(&a)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// What a move did: builds moved, and builds left where they were because the new folder already had one by that id.
#[derive(Serialize, Default, Debug)]
pub struct Moved {
    pub moved: usize,
    pub skipped: usize,
}

/// Moves every build folder (and the collections) from `from` into `to`: a
/// rename where the disk allows, else a copy then a delete. Collections are
/// merged by id, so a folder that already had a library keeps its own too.
pub fn move_library(from: &Path, to: &Path) -> Result<Moved, String> {
    let mut out = Moved::default();
    if !from.is_dir() {
        return Ok(out);
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name();
        let src = entry.path();
        let dst = to.join(&name);
        if name == "collections.json" {
            merge_collections(&src, &dst)?;
            let _ = fs::remove_file(&src);
            continue;
        }
        if !src.join("meta.json").is_file() {
            continue; // not a build: leave anything else alone
        }
        if dst.exists() {
            out.skipped += 1;
            continue;
        }
        if fs::rename(&src, &dst).is_err() {
            copy_dir(&src, &dst).map_err(|e| format!("copying {}: {e}", src.display()))?;
            fs::remove_dir_all(&src).map_err(|e| format!("removing {}: {e}", src.display()))?;
        }
        out.moved += 1;
    }
    // the old folder goes when nothing is left in it
    let _ = fs::remove_dir(from);
    Ok(out)
}

fn merge_collections(src: &Path, dst: &Path) -> Result<(), String> {
    let read = |p: &Path| -> Vec<serde_json::Value> {
        fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    };
    let mut list = read(dst);
    for c in read(src) {
        let id = c.get("id").cloned();
        if !list.iter().any(|x| x.get("id") == id.as_ref()) {
            list.push(c);
        }
    }
    let text = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    fs::write(dst, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gusgus-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moving_a_library_keeps_builds_and_merges_collections() {
        let base = tmp("move");
        let (a, b) = (base.join("a"), base.join("b"));
        for id in ["one", "two"] {
            fs::create_dir_all(a.join(id)).unwrap();
            fs::write(a.join(id).join("meta.json"), format!("{{\"id\":\"{id}\"}}")).unwrap();
            fs::write(a.join(id).join("thumb.png"), b"png").unwrap();
        }
        fs::write(a.join("collections.json"), r#"[{"id":"xmas","name":"Christmas"},{"id":"mine","name":"Mine"}]"#).unwrap();
        fs::create_dir_all(b.join("two")).unwrap();
        fs::write(b.join("two").join("meta.json"), "{\"id\":\"two\"}").unwrap();
        fs::write(b.join("collections.json"), r#"[{"id":"xmas","name":"Christmas"}]"#).unwrap();
        let r = move_library(&a, &b).unwrap();
        assert_eq!((r.moved, r.skipped), (1, 1));
        assert!(b.join("one").join("thumb.png").is_file());
        assert!(a.join("two").is_dir(), "a build already there stays where it was");
        let cols: Vec<serde_json::Value> = serde_json::from_str(&fs::read_to_string(b.join("collections.json")).unwrap()).unwrap();
        assert_eq!(cols.len(), 2);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn nested_folders_are_caught() {
        let base = tmp("nest");
        assert!(nested(&base, &base.join("x")));
        assert!(nested(&base.join("x"), &base));
        assert!(!nested(&base.join("x"), &base.join("y")));
        let _ = fs::remove_dir_all(&base);
    }
}
