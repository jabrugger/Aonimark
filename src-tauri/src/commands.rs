//! Every `#[tauri::command]` the frontend can `invoke`, plus the blocking
//! helpers they run on the pool.

use crate::fs_safety::{
    atomic_write, canonical_identity, encode_text, read_to_string_lossy,
};
use crate::window_runtime::{self, WatcherState};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// Runs `f` on the blocking pool. A panicked task reports its `JoinError` text.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(e.to_string()))
}

/// Reads a file, with the fidelity of the decode and the encoding it was
/// decoded from: returns `(content, lossy, encoding)`. A caller that puts the
/// text into an EDITABLE buffer must carry BOTH onto the tab — `lossy` so the
/// first auto-save does not write U+FFFD over a file that could not be read,
/// and `encoding` so it does not write UTF-8 over one that could.
///
/// Async so a read from a slow volume (SMB, iCloud) waits on the blocking
/// pool, not on the main thread that every window shares.
#[tauri::command]
#[specta::specta]
pub async fn read_file_content_checked(path: String) -> Result<(String, bool, String), String> {
    blocking(move || {
        crate::asset_protocol::trust_document_host(&path);
        read_to_string_lossy(&path)
            .map(|decoded| (decoded.content, decoded.lossy, decoded.encoding))
            .map_err(|e| e.to_string())
    })
    .await
}

/// Writes `content` to `path` as `encoding` — the label the file was decoded
/// from, so a legacy document is saved as the bytes it arrived as instead of
/// being silently converted to UTF-8 behind the user's back. Callers with text
/// Markpad generated itself (the HTML and SVG exports) pass `UTF-8`.
///
/// The label is not trusted: it makes a round trip through the frontend, and
/// `encode_text` rejects one it does not recognise rather than falling back to
/// a default that would write the wrong bytes.
///
/// Encoding happens BEFORE `atomic_write`, so a document with a character its
/// encoding cannot represent fails without the file being touched at all.
///
/// Async because `atomic_write` fsyncs twice (the file, then its directory).
/// On a network or removable volume that is seconds of blocking I/O, and on
/// the main thread it would stall every window until the save completes.
#[tauri::command]
#[specta::specta]
pub async fn save_file_content(
    path: String,
    content: String,
    encoding: String,
) -> Result<(), String> {
    blocking(move || {
        // As on read: a document saved to a share (Save As into
        // `\\host\share\`) resolves its relative images against that host.
        crate::asset_protocol::trust_document_host(&path);
        let bytes = encode_text(&content, &encoding)?;
        atomic_write(Path::new(&path), &bytes).map_err(|e| e.to_string())
    })
    .await
}

/// Resolve `path` to the identity the filesystem gives it — see
/// `canonical_identity` for what that folds and why the filesystem, rather
/// than a platform guess, is the thing being asked.
///
/// The frontend calls this once per path, when the path ENTERS the app, and
/// keeps the answer on the tab (`Tab.pathKey`). Comparisons themselves stay
/// synchronous string equality: `TabManager.claimPath` runs on every navigate
/// and cannot become async without turning six sync call sites into promises.
///
/// Async because `realpath` walks the path component by component and can hit
/// a network volume that is slow or unreachable.
#[tauri::command]
#[specta::specta]
pub async fn canonicalize_path(path: String) -> Result<String, String> {
    blocking(move || {
        canonical_identity(Path::new(&path))
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
}

/// Async because `reveal` blocks its caller until the file manager answers:
/// on Windows it spawns a COM worker for `SHOpenFolderAndSelectItems` and
/// joins it, on macOS it waits for `open -R`. Selecting a file on a network
/// volume makes that wait the share's, and on the main thread it would stall
/// every window until it returns.
#[tauri::command]
#[specta::specta]
pub async fn open_file_folder(path: String) -> Result<(), String> {
    blocking(move || opener::reveal(path).map_err(|e| e.to_string())).await
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const LAUNCHABLE_EXTENSIONS: &[&str] = &["desktop", "appimage", "run", "sh", "jar"];

/// Async because a rename is a round trip to whatever holds the path — on a
/// network or removable volume, seconds of blocking I/O for a metadata
/// operation that looks instant on a local disk.
#[tauri::command]
#[specta::specta]
pub async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    blocking(move || rename_file_blocking(Path::new(&old_path), Path::new(&new_path))).await
}

/// `fs::rename` replaces an existing target without asking, so a new name
/// that is already taken is refused. The exception is a target that is the
/// same file under another spelling — `a.md` to `A.md` on a case-insensitive
/// volume — which `canonical_identity` recognizes.
///
/// A rename names a file in the same folder. The frontend builds the new path
/// by swapping the last segment for what the user typed, so `sub/x.md` there
/// would move the file into a subfolder and `..` would name the folder itself.
fn rename_file_blocking(old_path: &Path, new_path: &Path) -> Result<(), String> {
    if new_path.parent() != old_path.parent() || new_path.file_name().is_none() {
        return Err("The new name must not contain a path separator".to_string());
    }
    if fs::symlink_metadata(new_path).is_ok() && !is_same_file(old_path, new_path) {
        let name = new_path.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!("\"{name}\" already exists"));
    }
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

fn is_same_file(a: &Path, b: &Path) -> bool {
    matches!(
        (canonical_identity(a), canonical_identity(b)),
        (Ok(a), Ok(b)) if a == b
    )
}

/// Async because arming a watcher opens the watched path, and an unreachable
/// one costs the full share timeout before it fails — `\\wsl$\…` with the
/// distro stopped is the case that prompted this. Inserting the new watcher
/// also drops the window's previous one, and that drop joins its thread.
///
/// `State` is resolved inside the closure rather than taken as a parameter:
/// `State<'_, _>` borrows from the app and cannot cross into a `'static`
/// blocking task. It is injected by Tauri either way, so the command's
/// frontend-facing arguments are unchanged.
#[tauri::command]
#[specta::specta]
pub async fn watch_file(
    window: tauri::Window,
    handle: AppHandle,
    path: String,
) -> Result<(), String> {
    let state_handle = handle.clone();
    blocking(move || {
        let state = state_handle.state::<WatcherState>();
        window_runtime::watch_file(window, handle, state, path)
    })
    .await
}

/// Records what colour the NEXT window should be painted before it has a webview.
///
/// The argument is an appearance — `"dark"`, `"light"` or `"system"` — and not
/// the theme the user picked. The theme itself is a frontend setting that lives
/// in `localStorage`, and one of its forms, `vscode:<name>`, is dark or light
/// according to a `type` field inside an imported JSON file. Resolving that here
/// would mean a second theme parser in Rust; the frontend has already parsed the
/// file by the time it applies the theme, so it sends the answer instead.
/// `app.rs` is the only reader — see the background colour it picks at startup.
#[tauri::command]
#[specta::specta]
pub fn save_theme(app: AppHandle, theme: Appearance) -> Result<(), String> {
    let theme_path = window_runtime::config_file(&app, "theme.txt")?;
    atomic_write(&theme_path, theme.as_str().as_bytes()).map_err(|e| e.to_string())
}

/// What `save_theme` writes to `theme.txt` and `app.rs` reads back, one word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    System,
    Light,
    Dark,
}

impl Appearance {
    fn as_str(self) -> &'static str {
        match self {
            Appearance::System => "system",
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }

    /// `theme.txt` as written. Anything else — no file, or the raw theme name
    /// older builds wrote — asks the OS.
    pub fn from_saved(saved: &str) -> Self {
        [Appearance::Light, Appearance::Dark]
            .into_iter()
            .find(|appearance| appearance.as_str() == saved)
            .unwrap_or(Appearance::System)
    }
}

#[tauri::command]
#[specta::specta]
pub fn is_win11() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        let hklim = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(current_version) =
            hklim.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        {
            if let Ok(current_build) = current_version.get_value::<String, _>("CurrentBuild") {
                if let Ok(build_num) = current_build.parse::<u32>() {
                    return build_num >= 22000;
                }
            }
        }
    }
    false
}

/// Whether this install is able to replace its own binary.
///
/// `tauri-plugin-updater` has exactly one install strategy on Linux: rename the
/// downloaded file over the running executable. That works for an AppImage,
/// which is a file the user owns, and for nothing else — a `.deb` or `.rpm`
/// puts the binary in `/usr/bin` and a snap mounts it from a read-only
/// squashfs.
///
/// It would normally choose `install_deb` / `install_rpm` instead, from a bundle
/// type patched into the binary after the build. That patch fails on Linux —
/// three `Failed to add bundler type to the binary` warnings in every release
/// build, one per bundle — so `tauri_utils::platform::bundle_type()` returns
/// `None` and all three formats fall through to the AppImage path. Those users
/// were told an update existed and then watched it fail to install. See #570;
/// `build.yml` already documents the same missing symbol for a different
/// consequence, the shape of `latest.json`'s platform keys.
///
/// Read through `Env` rather than `std::env::var("APPIMAGE")` directly: tauri
/// also checks that the running executable sits under `$TMPDIR/.mount_`, so
/// setting the variable by hand cannot make a package-managed install claim it
/// is updatable.
///
/// Windows and macOS are unaffected. Windows' updater runs the downloaded NSIS
/// installer rather than overwriting anything in place, and macOS is the one
/// platform where `bundle_type()` answers without the patch.
#[tauri::command]
#[specta::specta]
pub fn self_update_supported(app: AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    let is_appimage = app.env().appimage.is_some();
    #[cfg(not(target_os = "linux"))]
    let is_appimage = {
        let _ = app;
        false
    };
    self_update_supported_for(is_appimage)
}

/// Only Linux is gated: there only an AppImage can be replaced in place.
fn self_update_supported_for(is_appimage: bool) -> bool {
    !cfg!(target_os = "linux") || is_appimage
}

#[tauri::command]
#[specta::specta]
pub fn get_os_type() -> String {
    match std::env::consts::OS {
        os @ ("macos" | "windows" | "linux") => os,
        _ => "unknown",
    }
    .to_string()
}

/// Keep one `arboard::Clipboard` alive for the rest of the process, so that
/// what we copy survives the command that copied it (#729).
///
/// On X11 there is no clipboard store: the copying process owns the CLIPBOARD
/// selection and hands the bytes over when another app asks for them. arboard
/// serves those requests from a background thread and an invisible window it
/// destroys when the last `Clipboard` drops — which, with one built and
/// dropped per command, is the moment `clipboard_write_text` returns. Its only
/// parting move is to offer the data to a clipboard manager, so on a desktop
/// that ships one (GNOME) copying appears to work and on one that does not
/// (XFCE, the reporter's) everything Markpad copies is gone before it can be
/// pasted. Holding an instance keeps the window and the ownership; the
/// per-command `Clipboard::new()`s below reuse arboard's global and their drop
/// becomes a no-op.
///
/// Nowhere else needs this. On Wayland arboard uses the data-control protocol
/// (wl-clipboard-rs) when `WAYLAND_DISPLAY` is set and the compositor offers
/// it. Each copy is then served by a detached thread that no `Clipboard` owns,
/// so the instance forgotten here is an empty struct. A compositor without the
/// protocol falls back to X11 through XWayland, where the above applies. macOS
/// and Windows write into a store the system owns.
#[cfg(all(unix, not(target_os = "macos")))]
fn retain_clipboard_ownership() {
    use std::sync::atomic::AtomicBool;
    static RETAINED: AtomicBool = AtomicBool::new(false);

    retain_forever(&RETAINED, || arboard::Clipboard::new().ok());
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fs_safety::tests::temp_path;

    #[test]
    fn the_startup_reader_reads_back_every_appearance_save_theme_writes() {
        for appearance in [Appearance::System, Appearance::Light, Appearance::Dark] {
            assert_eq!(Appearance::from_saved(appearance.as_str()), appearance);
        }
        assert_eq!(Appearance::from_saved("dark"), Appearance::Dark);
        assert_eq!(Appearance::from_saved("light"), Appearance::Light);
    }

    #[test]
    fn a_case_only_rename_still_goes_through() {
        // On a case-insensitive volume `A.md` already "exists" — it is a.md
        // itself — so the existing-target check must compare identity, not
        // just ask whether the new name resolves.
        let root = temp_path("rename-case");
        fs::create_dir_all(&root).unwrap();
        let lower = root.join("a.md");
        let upper = root.join("A.md");
        fs::write(&lower, b"a").unwrap();

        rename_file_blocking(&lower, &upper).unwrap();
        let names: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["A.md"]);
        assert_eq!(fs::read(&upper).unwrap(), b"a");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_linux_gates_self_update() {
        // Windows runs the downloaded NSIS installer and macOS replaces the
        // bundle, so neither may be gated; on Linux only an AppImage updates.
        if cfg!(target_os = "linux") {
            assert!(self_update_supported_for(true));
            assert!(!self_update_supported_for(false));
        } else {
            assert!(self_update_supported_for(false));
            assert!(self_update_supported_for(true));
        }
    }
}
