// The desktop shell around the web app. The app itself is the same Vite build
// as the web version; the only thing the desktop adds is the library: saved
// builds kept as plain files in the app's data folder, one folder per build
// (meta.json, thumb.png, source file, state.json, the fitted part), so they
// can be backed up or copied to another computer by hand.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// The library folder: <app data>/library, made on first use.
fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data folder: {e}"))?
        .join("library");
    fs::create_dir_all(&root).map_err(|e| format!("cannot make {}: {e}", root.display()))?;
    Ok(root)
}

/// A path inside the library from the page: plain names joined by '/', never
/// absolute, never '..', never hidden, so nothing outside the library is reached.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    let mut any = false;
    for part in rel.split('/') {
        let ok = !part.is_empty()
            && !part.starts_with('.')
            && part.len() <= 128
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
        if !ok {
            return Err(format!("not a library path: {rel}"));
        }
        out.push(part);
        any = true;
    }
    if !any {
        return Err("empty library path".into());
    }
    Ok(out)
}

/// Where the library lives on disk, to show in the app.
#[tauri::command]
fn library_dir(app: AppHandle) -> Result<String, String> {
    Ok(library_root(&app)?.display().to_string())
}

/// Every build's meta.json, newest folders first is left to the page.
#[tauri::command]
fn library_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let root = library_root(&app)?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let meta = entry.path().join("meta.json");
        if !meta.is_file() {
            continue;
        }
        // a damaged meta.json is skipped rather than hiding the whole library
        if let Ok(text) = fs::read_to_string(&meta) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                out.push(value);
            }
        }
    }
    Ok(out)
}

/// A file of the library as bytes; an error when it is not there.
#[tauri::command]
fn library_read(app: AppHandle, path: String) -> Result<Response, String> {
    let file = inside(&library_root(&app)?, &path)?;
    fs::read(&file)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Writes the request body to the library path in the `x-path` header, via a
/// temporary file so a crash never leaves half a build behind.
#[tauri::command]
fn library_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let rel = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("no x-path header")?
        .to_string();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let file = inside(&library_root(&app)?, &rel)?;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("partial");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("{rel}: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("{rel}: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, &file).map_err(|e| format!("{rel}: {e}"))
}

/// Removes a file or a whole build folder.
#[tauri::command]
fn library_remove(app: AppHandle, path: String) -> Result<(), String> {
    let target = inside(&library_root(&app)?, &path)?;
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else if target.is_file() {
        fs::remove_file(&target).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Saves an export (the body) where the person picks in a Save dialog, starting
/// from the name in the `x-name` header. Ok(None) when they cancel. The web
/// version downloads instead; webviews do not all save blob downloads.
#[tauri::command]
async fn export_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
        .unwrap_or_else(|| "export".into());
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    let mut dialog = app.dialog().file().set_file_name(&name);
    if !ext.is_empty() {
        dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            library_dir,
            library_list,
            library_read,
            library_write,
            library_remove,
            export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Gus Gus Goose app");
}

#[cfg(test)]
mod tests {
    use super::inside;
    use std::path::Path;

    #[test]
    fn paths_stay_inside_the_library() {
        let root = Path::new("/lib");
        assert_eq!(inside(root, "abc/meta.json").unwrap(), Path::new("/lib/abc/meta.json"));
        for bad in ["", "../x", "a/../b", "/etc/passwd", "a//b", ".hidden", "a/b c", "a\\b"] {
            assert!(inside(root, bad).is_err(), "{bad} should be refused");
        }
    }
}
