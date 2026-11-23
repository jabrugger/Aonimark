use crate::fs_safety::atomic_write;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_specta::Event;

pub struct WatcherState {
    pub(crate) watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    /// Window label -> the newest watch request it made. Arming runs on the
    /// thread pool and can take seconds on a network share, so requests can
    /// finish out of order; only the newest may install its watcher.
    latest: Mutex<HashMap<String, u64>>,
    next_request: AtomicU64,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            latest: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(0),
        }
    }

    /// Makes a new request for `label`, superseding any still arming.
    fn request(&self, label: &str) -> u64 {
        let id = self.next_request.fetch_add(1, Ordering::SeqCst) + 1;
        lock_recover(&self.latest).insert(label.to_string(), id);
        id
    }

    /// Installs `watcher` for request `id` unless a newer request (or the
    /// window's destruction) came in behind it. A refused watcher is dropped,
    /// which unregisters it.
    fn install(&self, label: String, id: u64, watcher: RecommendedWatcher) -> bool {
        let latest = lock_recover(&self.latest);
        if latest.get(&label) != Some(&id) {
            return false;
        }
        lock_recover(&self.watchers).insert(label, watcher);
        true
    }

    /// Stops `label`'s watch, including one still arming.
    fn unwatch(&self, label: &str) {
        self.request(label);
        lock_recover(&self.watchers).remove(label);
    }

    /// The window is gone: no request of its own can install after this.
    pub(crate) fn forget_window(&self, label: &str) {
        let mut latest = lock_recover(&self.latest);
        latest.remove(label);
        lock_recover(&self.watchers).remove(label);
    }
}

/// The window Tauri builds at launch. Only startup tells it apart: it adopts a
/// remembered window when it has no snapshot of its own, takes the files the
/// launch was started with, and shows itself without taking focus. Its files
/// keep their pre-per-window names, so an older build still finds them.
pub const LAUNCH_LABEL: &str = "main";

pub struct AppState {
    /// Paths the launch was asked to open. `Some` until the window takes them;
    /// after that a path opened goes straight to the window.
    startup_files: Mutex<Option<Vec<String>>>,
    /// Orphan backups already handed to the window this launch.
    claimed_recovery: Mutex<HashSet<String>>,
    /// Files named on a command line, until the window opens them
    /// (`take_command_line_open`).
    command_line_files: Mutex<HashSet<String>>,
}

/// A file a command line named, as the window opening it needs to know it.
#[derive(serde::Serialize, specta::Type)]
pub struct CommandLineOpen {
    /// No file there yet: open an empty document that creates it on first save.
    missing: bool,
}

/// Locks `mutex`, recovering the guarded value if a previous holder panicked.
///
/// These mutexes guard plain bookkeeping — the window registry, pending
/// startup paths, the watcher map — none of which is left in a torn state by
/// a panic elsewhere. Propagating poisoning instead would turn one panic into
/// a permanently unusable registry: every later `set_window_meta`,
/// `list_viewer_windows` and window-destroyed handler would panic in turn.
///
/// `pinned_tags` is recovered on the same grounds even though it guards a
/// file: the only thing a panic inside the cycle can leave behind is the
/// pre-existing `pinned-tags.json`, because `atomic_write` publishes by
/// rename and a panic before it simply never publishes. There is no
/// half-applied state for the next holder to inherit, and propagating the
/// poison would instead make pinning fail for the rest of the session.
pub(crate) fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl AppState {
    pub fn new() -> Self {
        Self {
            startup_files: Mutex::new(Some(Vec::new())),
            claimed_recovery: Mutex::new(HashSet::new()),
            command_line_files: Mutex::new(HashSet::new()),
        }
    }
}

/// `file-path`: a file the OS asked this window to open.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct FilePath(pub String);

/// `file-changed`: the file this window watches changed on disk.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct FileChanged(pub String);

/// `name` in the app config dir, which is created if missing.
pub(crate) fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, crate::error::Error> {
    Ok(config_dir(app)?.join(name))
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Consumed by the launch window's first show. See `show_window`.
static MAIN_WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);

/// Whether this show is the launch window's first, the one that must not
/// activate. Asking consumes it. See `show_window`.
fn is_cold_start_show(label: &str, shown: &AtomicBool) -> bool {
    label == LAUNCH_LABEL && !shown.swap(true, Ordering::Relaxed)
}

/// Reveals a window that was built hidden.
///
/// The launch window is built hidden so no empty frame is on screen while the
/// webview boots, and the frontend calls this once it has mounted — seconds
/// after launch, by which time the user has usually gone back to whatever they
/// were doing. Activating then is wrong, and `set_focus` is not a polite
/// request to activate: it is each platform's override for the focus-stealing
/// prevention the OS applies on the user's behalf — `SetForegroundWindow` on
/// Windows, with a *synthesized Alt keypress* as the fallback when the OS
/// refuses, `activateIgnoringOtherApps:` on macOS, `present_with_time` passed
/// `GDK_CURRENT_TIME` on Linux. Shown without it, the window appears behind
/// whatever the user moved on to and waits there (#702).
///
/// Only that first show is quiet. Every other caller is answering something the
/// user just did — a detached tab window revealing itself, or the close walk
/// bringing its window up so the dialog is not hidden behind another — and each
/// of those must still come to the front.
#[tauri::command]
#[specta::specta]
pub async fn show_window(window: tauri::Window) {
    let is_cold_start = is_cold_start_show(window.label(), &MAIN_WINDOW_SHOWN);

    let _ = window.show();

    if is_cold_start {
        return;
    }

    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// The launch window's snapshot keeps its pre-per-window name, so an existing
/// session needs no migration and an older build still finds it.
const MAIN_WINDOW_STATE: &str = "window-state-v2.json";
/// Every other remembered window has a snapshot here, named by its label.
/// One file per window: N windows closing at once never write the same file.
const WINDOW_STATE_DIR: &str = "window-state";
const MAIN_RESTORE_PROGRESS: &str = "restore-progress-v1.json";
const RESTORE_PROGRESS_DIR: &str = "restore-progress";

fn config_dir(app: &AppHandle) -> Result<PathBuf, crate::error::Error> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// `label`'s file in a per-window directory. Only `window-*` windows have one:
/// the launch window has its own file, and anything else is not a window
/// startup reopens.
fn secondary_window_file(dir: &Path, label: &str) -> Result<PathBuf, String> {
    if !label.starts_with("window-") {
        return Err(format!("not a secondary window label: {label}"));
    }
    label_file(dir, label)
}

fn window_state_path_in(config: &Path, label: &str) -> Result<PathBuf, String> {
    if label == LAUNCH_LABEL {
        return Ok(config.join(MAIN_WINDOW_STATE));
    }
    secondary_window_file(&config.join(WINDOW_STATE_DIR), label)
}

fn restore_progress_path_in(config: &Path, label: &str) -> Result<PathBuf, String> {
    if label == LAUNCH_LABEL {
        return Ok(config.join(MAIN_RESTORE_PROGRESS));
    }
    secondary_window_file(&config.join(RESTORE_PROGRESS_DIR), label)
}

/// Writes a file Markpad owns in one of its per-window directories. Like
/// `atomic_write`, but refuses to follow a symlink into a document.
fn write_owned_file(path: &Path, json: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("target is not a regular file".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    atomic_write(path, json.as_bytes()).map_err(|error| error.to_string())
}

fn save_window_state_in(config: &Path, label: &str, json: &str) -> Result<(), String> {
    let path = window_state_path_in(config, label)?;
    write_owned_file(&path, json)
}

fn load_window_state_in(config: &Path, label: &str) -> Option<String> {
    fs::read_to_string(window_state_path_in(config, label).ok()?).ok()
}

fn remove_dir_if_exists(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Every window's snapshot, for the setting that turns restore off.
fn clear_window_state_in(config: &Path) -> Result<(), String> {
    remove_if_exists(&config.join(MAIN_WINDOW_STATE))?;
    remove_dir_if_exists(&config.join(WINDOW_STATE_DIR))?;
    remove_dir_if_exists(&config.join(RESTORE_PROGRESS_DIR))
}

/// Persists the calling window's restore snapshot atomically.
///
/// This runs as the window changes and while it closes, when the WebKit
/// storage process may already be tearing down, so a partial write is a
/// realistic outcome, not a theoretical one. `fs::write` truncates first and
/// then streams, so a crash mid-write leaves behind half a JSON document, and
/// the next launch restores no tabs at all. `atomic_write` publishes the new
/// snapshot with a rename: the file on disk is either entirely the old
/// session or entirely the new one.
///
/// Off the main thread: the two fsyncs cost ~8 ms, and on it every window
/// freezes for that long. The caller still awaits the write.
#[tauri::command]
#[specta::specta]
pub async fn save_window_state(
    window: tauri::Window,
    app: AppHandle,
    json: String,
) -> Result<(), String> {
    let config = config_dir(&app)?;
    let label = window.label().to_string();
    crate::commands::blocking(move || save_window_state_in(&config, &label, &json)).await
}

#[tauri::command]
#[specta::specta]
pub fn load_window_state(window: tauri::Window, app: AppHandle) -> Option<String> {
    load_window_state_in(&config_dir(&app).ok()?, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn clear_window_state(app: AppHandle) -> Result<(), String> {
    clear_window_state_in(&config_dir(&app)?)
}

const UNSAVED_RECOVERY_DIR: &str = "unsaved-recovery";

fn unsaved_recovery_dir(app: &AppHandle) -> Result<PathBuf, crate::error::Error> {
    config_file(app, UNSAVED_RECOVERY_DIR)
}

fn label_file(dir: &Path, label: &str) -> Result<PathBuf, String> {
    if label.is_empty()
        || !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!("invalid window label: {label}"));
    }
    Ok(dir.join(format!("{label}.json")))
}

fn remove_recovery_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Each window replaces only its own snapshot, never a document on disk.
fn save_unsaved_recovery_at(dir: &Path, label: &str, json: &str) -> Result<(), String> {
    let path = label_file(dir, label)?;
    if json.trim() == "[]" {
        return remove_recovery_file(&path);
    }
    write_owned_file(&path, json)
}

fn load_unsaved_recovery_at(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut snapshots = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(label) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if label_file(dir, label).is_err() || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        // One unreadable file must not hide the others. It arrives empty, which
        // the frontend rejects as a corrupt record and leaves on disk.
        let json = fs::read_to_string(entry.path()).unwrap_or_default();
        snapshots.push((label.to_string(), json));
    }
    snapshots.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(snapshots)
}

fn clear_unsaved_recovery_at(dir: &Path, labels: &[String]) -> Result<(), String> {
    // Validate the whole request before deleting any snapshot.
    let paths = labels
        .iter()
        .map(|label| label_file(dir, label))
        .collect::<Result<Vec<_>, _>>()?;
    for path in paths {
        remove_recovery_file(&path)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn save_unsaved_recovery(
    window: tauri::WebviewWindow,
    app: AppHandle,
    json: String,
) -> Result<(), String> {
    let dir = unsaved_recovery_dir(&app)?;
    let label = window.label().to_string();
    crate::commands::blocking(move || save_unsaved_recovery_at(&dir, &label, &json)).await
}

/// The backups a window takes in at startup: its own, and each orphan no other
/// window has taken yet. An orphan is a backup whose window is not open and
/// has no snapshot, so nothing will reopen it — after a crash before the
/// window's first snapshot, say, or with restore off.
fn claim_recovery_records(
    records: Vec<(String, String)>,
    own: &str,
    is_orphan: impl Fn(&str) -> bool,
    claimed: &mut HashSet<String>,
) -> Vec<(String, String)> {
    records
        .into_iter()
        .filter(|(label, _)| label == own || (is_orphan(label) && claimed.insert(label.clone())))
        .collect()
}

/// Whichever window asks first gets the orphans, once: two windows starting
/// together must not both restore the same unsaved buffer.
#[tauri::command]
#[specta::specta]
pub async fn claim_unsaved_recovery(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<(String, String)>, String> {
    let dir = unsaved_recovery_dir(&app)?;
    let config = config_dir(&app)?;
    let records = crate::commands::blocking(move || load_unsaved_recovery_at(&dir)).await?;
    let open = app.webview_windows();
    let state = app.state::<AppState>();
    let mut claimed = lock_recover(&state.claimed_recovery);
    Ok(claim_recovery_records(
        records,
        window.label(),
        |label| {
            !open.contains_key(label)
                && !window_state_path_in(&config, label).is_ok_and(|path| path.exists())
        },
        &mut claimed,
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn clear_unsaved_recovery(app: AppHandle, labels: Vec<String>) -> Result<(), String> {
    let dir = unsaved_recovery_dir(&app)?;
    crate::commands::blocking(move || clear_unsaved_recovery_at(&dir, &labels)).await
}

/// Publishes the restore breadcrumb by rename, but without `atomic_write`'s
/// fsyncs.
///
/// The breadcrumb is the record a launch leaves before it reads a document, so
/// that the launch after it knows which document killed it. It lives here for
/// the reason the snapshot does: `localStorage.setItem` is an async message to
/// the WebKit storage process, and the abnormal termination this record exists
/// to survive is exactly the event that loses messages in flight. Keeping the
/// one piece of state whose whole job is to outlive a kill in the store this
/// codebase had already proved does not survive one is what left #201's
/// reporter relaunching into the same hang.
///
/// The rename is not decoration: `fs::write` truncates before it writes, so a
/// process killed mid-call leaves an empty file — and an empty breadcrumb
/// reads as "nothing was interrupted", the one direction this record must
/// never fail in. What it does *not* need is durability past a power cut. The
/// event it survives is the process dying, and a rename the kernel has
/// accepted is visible to every later process whether or not it reached the
/// platter; after a power cut the breadcrumb is simply absent and startup
/// behaves as it did before this file existed. That is worth separating from
/// `atomic_write`, which runs on the user's documents and must survive the
/// stronger event, because this one runs once per document on every launch:
/// measured on macOS/APFS with a 122-byte payload, `atomic_write`'s two fsyncs
/// cost ~8 ms per call against ~0.2 ms for temp-file-plus-rename.
fn write_restore_progress(path: &Path, json: &str) -> std::io::Result<()> {
    // Two Markpad processes (Windows, Linux), or two windows of one, would
    // otherwise share a temp name and the loser would delete the winner's file
    // out from under its rename.
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("restore-progress");
    let temp = path.with_file_name(format!(".{name}-{}.tmp", std::process::id()));
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        std::io::Write::write_all(&mut file, json.as_bytes())?;
        // Closed before the rename: Windows tolerates renaming an open handle
        // only because Rust opens with FILE_SHARE_DELETE, which is a detail of
        // the standard library rather than a promise to this caller.
        drop(file);
        fs::rename(&temp, path)
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// Each window guards its own restore: the breadcrumb is keyed by the caller's label.
#[tauri::command]
#[specta::specta]
pub fn save_restore_progress(
    window: tauri::Window,
    app: AppHandle,
    json: String,
) -> Result<(), String> {
    let path = restore_progress_path_in(&config_dir(&app)?, window.label())?;
    write_restore_progress(&path, &json).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn load_restore_progress(window: tauri::Window, app: AppHandle) -> Option<String> {
    fs::read_to_string(restore_progress_path_in(&config_dir(&app).ok()?, window.label()).ok()?).ok()
}

#[tauri::command]
#[specta::specta]
pub fn clear_restore_progress(window: tauri::Window, app: AppHandle) -> Result<(), String> {
    remove_if_exists(&restore_progress_path_in(
        &config_dir(&app)?,
        window.label(),
    )?)
}

pub fn bring_to_front<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Joins `path` to the launch's files while the window has not taken them yet,
/// keeping every one delivered. False once they have been taken.
fn queue_startup_file(pending: &mut Option<Vec<String>>, path: &str) -> bool {
    match pending.as_mut() {
        Some(paths) => {
            paths.push(path.to_string());
            true
        }
        None => false,
    }
}

/// The launch's files: every path the OS delivered before the window asked, in
/// delivery order, ahead of the argv paths it did not already name.
fn merge_startup_files(opened: Vec<String>, mut files: Vec<String>) -> Vec<String> {
    for path in opened.into_iter().rev() {
        if !files.contains(&path) {
            files.insert(0, path);
        }
    }
    files
}

/// A file opened by the OS. Until the window has taken the launch's files it
/// joins them, and `send_markdown_path` hands them over; after that it goes to
/// the window as `file-path`.
pub fn deliver_opened_path<R: Runtime>(app: &AppHandle<R>, path: String) {
    let state = app.state::<AppState>();
    if queue_startup_file(&mut lock_recover(&state.startup_files), &path) {
        return;
    }
    if let Some(window) = app.get_webview_window(LAUNCH_LABEL) {
        let _ = FilePath(path).emit_to(app, window.label());
        bring_to_front(&window);
    }
}

/// The openable paths named on a command line, in order, resolved against the
/// directory the command was run from.
///
/// argv is the one path source nobody vetted. Every other way a path enters is
/// narrower: the file picker returns a file that exists, and macOS's
/// `RunEvent::Opened` carries a URL Launch Services already resolved to a real
/// file it decided Markpad handles. Here the shell hands over whatever was
/// typed, and what comes back goes straight to the frontend's `loadMarkdown`,
/// so it has to be a path a document could plausibly live at.
///
/// Relative arguments are resolved rather than left for the eventual read to
/// resolve against the process's own directory. Both answer the same at
/// launch, but the resolved string is what the tab, the recent-files list and
/// the watcher keep — a bare `notes.md` in the recent list names whatever
/// directory the NEXT launch happens to start in.
///
/// Dropped, silently, because there is nothing to open and no channel here to
/// report on:
/// - a directory, and any argument with a trailing separator, which spells a
///   directory whether or not one exists there. `markpad ~/notes/` otherwise
///   opens a tab whose path is a directory: every read of it fails, and the
///   tab has a path so `serializeState` persists it — the failure then repeats
///   on every later launch until the user closes the tab.
/// - the empty string, which names no file at all.
///
/// A path that does not exist is KEPT. `markpad draft.md` naming a file yet to
/// be written is the request `vim` and `code` answer with an empty buffer at
/// that name, and nothing here can tell it from a typo; dropping it would
/// answer a deliberate request with an empty window. An existing file that is
/// not Markdown is kept too — Markpad's own Open dialog offers "All Files", so
/// the extension is not what decides whether a path is openable.
pub fn startup_paths(args: &[String], cwd: &Path) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
        .filter_map(|arg| {
            if arg.ends_with(std::path::is_separator) {
                return None;
            }
            let path = Path::new(arg);
            let resolved = if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            };
            if resolved.is_dir() {
                return None;
            }
            Some(resolved.display().to_string())
        })
        .collect()
}

/// `startup_paths`, recorded for `take_command_line_open`.
pub fn command_line_paths<R: Runtime>(
    app: &AppHandle<R>,
    args: &[String],
    cwd: &Path,
) -> Vec<String> {
    let paths = startup_paths(args, cwd);
    let state = app.state::<AppState>();
    let mut recorded = lock_recover(&state.command_line_files);
    recorded.extend(paths.iter().cloned());
    paths
}

/// Asked once per file a window opens from outside the app. `None` for a file
/// no command line named, which opens as before.
#[tauri::command]
#[specta::specta]
pub async fn take_command_line_open(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<CommandLineOpen>, String> {
    if !lock_recover(&state.command_line_files).remove(&path) {
        return Ok(None);
    }
    let missing = crate::commands::blocking(move || Ok(names_no_file(Path::new(&path)))).await?;
    Ok(Some(CommandLineOpen { missing }))
}

/// Forgets what a command line asked for `path`: the OS opened it some other
/// way (a Finder open on macOS), so the request is not this open's.
// Only macOS has open-document events; the other platforms open files by argv.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn forget_command_line_open<R: Runtime>(app: &AppHandle<R>, path: &str) {
    lock_recover(&app.state::<AppState>().command_line_files).remove(path);
}

/// True only when the filesystem says nothing is there. A path it cannot
/// read for another reason (permissions, a sharing violation) is not missing.
fn names_no_file(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// Whether `path` names no file yet. Asked by a save that is to create it.
#[tauri::command]
#[specta::specta]
pub async fn path_is_missing(path: String) -> Result<bool, String> {
    crate::commands::blocking(move || Ok(names_no_file(Path::new(&path)))).await
}

pub fn handle_single_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
    // Explorer launches one process per selected file, so these can arrive
    // before the launch window listens; `deliver_opened_path` queues them and
    // fronts the window each one lands in.
    let paths = command_line_paths(app, &args, Path::new(&cwd));
    if paths.is_empty() {
        if let Some(window) = app.get_webview_window(LAUNCH_LABEL) {
            bring_to_front(&window);
        }
    }
    for path in paths {
        deliver_opened_path(app, path);
    }
}

/// The path a watch for `target` is armed on: its parent directory.
///
/// Not `target` itself, which is what this used to be. A Linux `inotify` watch
/// resolves the path once and then follows the INODE, and `atomic_write` — like
/// VS Code, Vim, JetBrains and Emacs — saves by writing a temp file alongside
/// and renaming it over the top. That leaves a new inode at the same path, so
/// the watch was left holding the unlinked old one: after the first save, its
/// own or anyone else's, the watcher on Linux reported nothing for the rest of
/// the session, and the callback swallowed the error that said so.
/// `watch_survives_rename` below is that failure, pinned per platform.
///
/// A directory watch has no such problem, because the directory is the thing
/// whose entries changed. The cost is hearing about every sibling file, which
/// `event_concerns` drops on a name comparison — cheaper than the emit it
/// replaces.
///
/// Falls back to the target itself when there is no usable parent (a bare
/// relative filename, or a filesystem root), which keeps the previous
/// behaviour for the cases a directory watch cannot serve.
fn watch_root(target: &Path) -> PathBuf {
    match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() && target.file_name().is_some() => {
            parent.to_path_buf()
        }
        _ => target.to_path_buf(),
    }
}

/// Whether `event` is about the watched file rather than one of its neighbours.
///
/// Compares file names, not whole paths: the watch covers exactly one
/// directory, so the name is already unambiguous within it, and the platforms
/// do not agree on how to spell the directory back to us (macOS reports
/// `/private/var/...` for a path opened as `/var/...`). A rename that brings a
/// different file to this name is reported too, which is right — the file at
/// this path changed.
///
/// `atomic_write`'s temp file is a sibling with a different name, so a save
/// emits for the rename and not for the temp write that precedes it.
///
/// `None` means the watch is on the file itself (see `watch_root`), where
/// there is nothing to filter out.
fn event_concerns(event: &notify::Event, file_name: Option<&OsStr>) -> bool {
    match file_name {
        None => true,
        Some(name) => event.paths.iter().any(|p| p.file_name() == Some(name)),
    }
}

/// Turns a burst of calls into one call of `f`, `delay` after the first.
///
/// A save is several events — an editor's temp write and rename, or a
/// truncate and a write — and each `file-changed` is a full reload. Calls
/// that land while one is pending ride on it; it runs after them, so it sees
/// their result. The flag is cleared before `f` runs, so a call made while
/// `f` is running schedules another rather than being lost. A file written
/// continuously still emits every `delay`, where a debounce would wait for it
/// to go quiet.
pub(crate) fn coalesced(
    delay: Duration,
    f: impl Fn() + Send + Sync + 'static,
) -> impl Fn() + Send + 'static {
    let f = Arc::new(f);
    let pending = Arc::new(AtomicBool::new(false));
    move || {
        if pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (f, pending) = (f.clone(), pending.clone());
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            pending.store(false, Ordering::SeqCst);
            f();
        });
    }
}

pub fn watch_file(
    window: tauri::Window,
    handle: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let request = state.request(&label);
    let event_label = label.clone();
    let watched_path = path.clone();

    // The DIRECTORY, not the file — see `watch_root`. The filename is kept so
    // the callback can drop everything else that happens in it.
    let target = Path::new(&path);
    let file_name = target.file_name().map(OsStr::to_os_string);
    let root = watch_root(target);

    // Build and arm the replacement *before* touching the watcher already
    // registered for this window. Dropping the old one first would leave the
    // window with no watcher at all if either step below failed: the frontend
    // only logs the error, so external edits would silently stop being
    // reported for the rest of the session. `install` swaps them in one step —
    // the map drops the previous watcher, which unregisters it.
    let emit = coalesced(Duration::from_millis(150), move || {
        let _ = FileChanged(watched_path.clone()).emit_to(&handle, event_label.as_str());
    });
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else { return };
            if !event_concerns(&event, file_name.as_deref()) {
                return;
            }
            emit();
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    state.install(label, request, watcher);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn unwatch_file(window: tauri::Window, state: State<'_, WatcherState>) -> Result<(), String> {
    state.unwatch(window.label());
    Ok(())
}

/// The launch's files, handed once to the window. Any later ask gets nothing.
#[tauri::command]
#[specta::specta]
pub fn send_markdown_path(state: State<'_, AppState>) -> Vec<String> {
    let Some(opened) = lock_recover(&state.startup_files).take() else {
        return Vec::new();
    };
    let args: Vec<String> = std::env::args().collect();
    let files = startup_paths(&args, &std::env::current_dir().unwrap_or_default());
    merge_startup_files(opened, files)
}

/// What the window-state plugin keeps for every window.
pub fn geometry_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::SIZE
        | StateFlags::POSITION
        | StateFlags::MAXIMIZED
        | StateFlags::VISIBLE
        | StateFlags::FULLSCREEN
}

pub fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::Destroyed = event {
        window.state::<WatcherState>().forget_window(window.label());
    }
}

#[cfg(test)]
mod tests {
    
    

    

}

/// Does a watch armed on a FILE survive that file being replaced by a rename?
///
/// Not a test of Markpad's code — a test of the platform behaviour `watch_file`
/// rests on, which is the only way to know whether the assumption holds on the
/// three targets. `atomic_write` saves every document by writing a temp file
/// alongside and renaming it over the target, so this is not an exotic case:
/// it is what one Markpad save does to its own watch, and what most editors do
/// to it (VS Code, Vim, JetBrains, Emacs all rename on save).
///
/// If this fails on a platform, the watcher there stops reporting anything
/// after the first save, silently and for the rest of the session.
#[cfg(test)]
mod watch_targeting {
    
    
    

}

#[cfg(test)]
mod coalesced_calls {
    
    
    

}

#[cfg(test)]
mod watch_survives_rename {
    
    
    

}
