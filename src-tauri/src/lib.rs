mod grid_file;

use std::{path::PathBuf, sync::Mutex};
#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{
  ipc::{InvokeBody, Request, Response},
  Emitter, Manager,
};

fn path_of(request: &Request<'_>) -> Result<PathBuf, String> {
  let raw = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("Pfad fehlt")?;
  // Der Pfad kommt URL-kodiert an (HTTP-Header dürfen nur ASCII enthalten).
  let mut bytes = Vec::with_capacity(raw.len());
  let b = raw.as_bytes();
  let mut i = 0;
  while i < b.len() {
    if b[i] == b'%' && i + 2 < b.len() {
      let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
      bytes.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
      i += 3;
    } else {
      bytes.push(b[i]);
      i += 1;
    }
  }
  String::from_utf8(bytes).map(PathBuf::from).map_err(|e| e.to_string())
}

/// Schreibt Änderungen in die .grid-Datei (oder legt sie neu an). Body: Binärpaket der Oberfläche, Header `x-path`: Zielpfad.
/// Liefert die Zahl der Updates im Protokoll.
#[tauri::command]
async fn grid_save(request: Request<'_>) -> Result<u64, String> {
  let path = path_of(&request)?;
  let InvokeBody::Raw(body) = request.body() else { return Err("Binärdaten erwartet".into()) };
  grid_file::save_grid(&path, body)
}

/// Liest eine .grid-Datei. Header `x-path`: Quellpfad (der Body ist leer).
#[tauri::command]
async fn grid_open(request: Request<'_>) -> Result<Response, String> {
  let path = path_of(&request)?;
  grid_file::open_grid(&path).map(Response::new)
}

// ---------- Konto-Schlüssel ----------
// Der geheime Schlüssel des Grid-Kontos (als Text) liegt im Schlüsselbund des Betriebssystems. Wo es keinen gibt
// (oder er nicht antwortet), ersatzweise in einer Datei, die nur der Benutzer lesen darf.

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
/// Name des Eintrags im Schlüsselbund. Bleibt absichtlich die frühere App-Kennung, damit das Konto nach der Umbenennung der App gefunden wird.
const KEY_SERVICE: &str = "app.grid.desktop";
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
const KEY_NAME: &str = "account";

fn key_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir.join("account.key"))
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
fn keychain_get() -> Option<String> {
  keyring::Entry::new(KEY_SERVICE, KEY_NAME).ok()?.get_password().ok()
}
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
fn keychain_get() -> Option<String> { None }

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
fn keychain_set(value: &str) -> bool {
  keyring::Entry::new(KEY_SERVICE, KEY_NAME).and_then(|e| e.set_password(value)).is_ok()
}
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
fn keychain_set(_: &str) -> bool { false }

#[tauri::command]
fn identity_load(app: tauri::AppHandle) -> Option<String> {
  keychain_get().or_else(|| std::fs::read_to_string(key_file(&app).ok()?).ok()).filter(|s| !s.trim().is_empty())
}

#[tauri::command]
fn identity_store(app: tauri::AppHandle, value: String) -> Result<(), String> {
  if keychain_set(&value) { return Ok(()); }
  let path = key_file(&app)?;
  std::fs::write(&path, &value).map_err(|e| e.to_string())?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
  }
  Ok(())
}

// ---------- Dokumente im App-Ordner (iPad/iPhone) ----------
// Ohne Menüleiste und ohne frei wählbare Orte liegen die Dokumente im Ordner „Dokumente“ der App (in der Dateien-App sichtbar).

/// Plattform der App: „ios“, „android“ oder „desktop“.
#[tauri::command]
fn app_platform() -> &'static str {
  if cfg!(target_os = "ios") { "ios" } else if cfg!(target_os = "android") { "android" } else { "desktop" }
}

fn documents_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().document_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

#[tauri::command]
fn docs_dir(app: tauri::AppHandle) -> Result<String, String> {
  documents_folder(&app).map(|p| p.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
struct DocFile {
  name: String,
  path: String,
  /// Änderungszeit in Sekunden seit 1970
  modified: u64,
  size: u64,
}

/// Alle .grid-Dateien im App-Ordner, neueste zuerst.
#[tauri::command]
fn list_documents(app: tauri::AppHandle) -> Result<Vec<DocFile>, String> {
  let dir = documents_folder(&app)?;
  let mut out = Vec::new();
  for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("grid")) != Some(true) { continue; }
    let Ok(meta) = entry.metadata() else { continue };
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let name = path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    out.push(DocFile { name, path: path.to_string_lossy().to_string(), modified, size: meta.len() });
  }
  out.sort_by(|a, b| b.modified.cmp(&a.modified));
  Ok(out)
}

/// Löscht ein Dokument aus dem App-Ordner (andere Orte sind tabu).
#[tauri::command]
fn delete_document(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let dir = documents_folder(&app)?.canonicalize().map_err(|e| e.to_string())?;
  let file = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
  if file.parent() != Some(dir.as_path()) || file.extension().and_then(|e| e.to_str()) != Some("grid") {
    return Err("Nur Dokumente im App-Ordner dürfen gelöscht werden".into());
  }
  // SQLite legt neben der Datei ggf. -wal/-shm ab
  for suffix in ["", "-wal", "-shm"] {
    let p = PathBuf::from(format!("{}{suffix}", file.display()));
    if p.exists() { std::fs::remove_file(&p).map_err(|e| e.to_string())?; }
  }
  Ok(())
}

/// Per Finder (Doppelklick, „Öffnen mit“) angeforderte Datei, bis die Oberfläche sie abgeholt hat
/// (beim Kaltstart kommt das Ereignis vor dem ersten Rendern).
#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
  state.0.lock().ok().and_then(|mut p| p.take())
}

/// Menüleiste: Datei-Befehle gehen als Ereignis „menu“ an die Oberfläche. `recent` sind die Namen der zuletzt
/// geöffneten Dateien; ein Klick darauf sendet „recent:<Nummer>“, die Oberfläche kennt die zugehörigen Pfade.
/// Stand der Menüleiste, damit sie sich bei Änderungen an einer Stelle neu aufbauen lässt.
struct MenuState {
  recent: Mutex<Vec<String>>,
  /// „system“, „light“ oder „dark“
  theme: Mutex<String>,
}

#[cfg(desktop)]
fn build_menu<M: tauri::Manager<tauri::Wry>>(app: &M, recent: &[String], _theme: &str) -> tauri::Result<()> {
  let item = |id: &str, text: &str, accel: &str| MenuItemBuilder::with_id(id, text).accelerator(accel).build(app);
  let mut recents = SubmenuBuilder::new(app, "Zuletzt geöffnet");
  if recent.is_empty() {
    recents = recents.item(&MenuItemBuilder::with_id("recent_none", "Keine").enabled(false).build(app)?);
  } else {
    for (i, name) in recent.iter().enumerate() {
      recents = recents.item(&MenuItemBuilder::with_id(format!("recent:{i}"), name).build(app)?);
    }
    recents = recents.separator().item(&MenuItemBuilder::with_id("clear_recent", "Liste löschen").build(app)?);
  }
  let file = SubmenuBuilder::new(app, "Ablage")
    .item(&item("new", "Neu …", "CmdOrCtrl+N")?)
    .item(&item("open", "Öffnen …", "CmdOrCtrl+O")?)
    .item(&MenuItemBuilder::with_id("open_cloud", "Aus Cloud öffnen …").build(app)?)
    .item(&MenuItemBuilder::with_id("join", "Einladung annehmen …").build(app)?)
    .item(&recents.build()?)
    .separator()
    .item(&item("save", "Sichern", "CmdOrCtrl+S")?)
    .item(&item("save_as", "Sichern unter …", "CmdOrCtrl+Shift+S")?)
    .separator()
    .close_window()
    .build()?;
  let edit = SubmenuBuilder::new(app, "Bearbeiten")
    .item(&item("undo", "Rückgängig", "CmdOrCtrl+Z")?)
    .item(&item("redo", "Wiederholen", "CmdOrCtrl+Shift+Z")?)
    .separator().cut().copy().paste().select_all()
    .build()?;
  let app_menu = SubmenuBuilder::new(app, "Grid")
    .about(None).separator()
    .item(&MenuItemBuilder::with_id("account", "Konto …").build(app)?)
    .item(&MenuItemBuilder::with_id("settings", "Einstellungen …").accelerator("CmdOrCtrl+,").build(app)?)
    .separator().hide().hide_others().show_all().separator().quit()
    .build()?;
  let logs = SubmenuBuilder::new(app, "Logs")
    .item(&MenuItemBuilder::with_id("logs_all", "Alle Änderungen anzeigen …").build(app)?)
    .item(&MenuItemBuilder::with_id("logs_asof", "Stand anzeigen von …").build(app)?)
    .separator()
    .item(&MenuItemBuilder::with_id("logs_settings", "Aufbewahrung …").build(app)?)
    .build()?;
  let window = SubmenuBuilder::new(app, "Fenster").minimize().maximize().build()?;
  app.app_handle().set_menu(MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &logs, &window]).build()?)?;
  Ok(())
}

/// Ersetzt das Untermenü „Zuletzt geöffnet“ durch die übergebenen Dateinamen.
#[tauri::command]
fn set_recent_menu(app: tauri::AppHandle, state: tauri::State<'_, MenuState>, names: Vec<String>) -> Result<(), String> {
  *state.recent.lock().map_err(|e| e.to_string())? = names.clone();
  #[cfg(desktop)]
  {
    let theme = state.theme.lock().map_err(|e| e.to_string())?.clone();
    return build_menu(&app, &names, &theme).map_err(|e| e.to_string());
  }
  #[cfg(not(desktop))]
  {
    let _ = app; // iPad/iPhone: es gibt keine Menüleiste, die Oberfläche zeigt die Liste selbst
    Ok(())
  }
}

/// Erscheinungsbild („system“, „light“, „dark“): Haken im Menü und Darstellung des Fensters (Titelleiste) anpassen.
#[tauri::command]
fn set_theme(app: tauri::AppHandle, state: tauri::State<'_, MenuState>, choice: String) -> Result<(), String> {
  let choice = if matches!(choice.as_str(), "light" | "dark") { choice } else { "system".to_string() };
  *state.theme.lock().map_err(|e| e.to_string())? = choice.clone();
  #[cfg(desktop)]
  {
    let recent = state.recent.lock().map_err(|e| e.to_string())?.clone();
    build_menu(&app, &recent, &choice).map_err(|e| e.to_string())?;
    let theme = match choice.as_str() { "light" => Some(tauri::Theme::Light), "dark" => Some(tauri::Theme::Dark), _ => None };
    for (_, window) in app.webview_windows() {
      let _ = window.set_theme(theme);
    }
  }
  #[cfg(not(desktop))]
  let _ = app;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_iap::init())
    .manage(PendingOpen::default())
    .manage(MenuState { recent: Mutex::new(Vec::new()), theme: Mutex::new("system".to_string()) })
    .invoke_handler(tauri::generate_handler![grid_save, grid_open, take_pending_open, set_recent_menu, set_theme, identity_load, identity_store, app_platform, docs_dir, list_documents, delete_document])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(desktop)]
      build_menu(app.handle(), &[], "system")?;
      Ok(())
    });
  #[cfg(desktop)]
  let builder = builder.on_menu_event(|app, event| {
    let _ = app.emit("menu", event.id().as_ref());
  });
  builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // macOS: Doppelklick auf eine .grid-Datei im Finder.
      #[cfg(any(target_os = "macos", target_os = "ios"))]
      if let tauri::RunEvent::Opened { urls } = event {
        use tauri::Manager;
        if let Some(path) = urls.iter().filter_map(|u| u.to_file_path().ok()).next() {
          let path = path.to_string_lossy().to_string();
          if let Ok(mut p) = app.state::<PendingOpen>().0.lock() {
            *p = Some(path.clone());
          }
          let _ = app.emit("open-file", path);
        }
      }
      #[cfg(not(any(target_os = "macos", target_os = "ios")))]
      let _ = (app, event);
    });
}
