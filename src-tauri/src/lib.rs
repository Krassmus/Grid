mod grid_file;

use std::{path::PathBuf, sync::Mutex};
use tauri::{
  ipc::{InvokeBody, Request, Response},
  menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
  Emitter,
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

/// Schreibt das Dokument als .grid-Datei. Body: Binärpaket der Oberfläche, Header `x-path`: Zielpfad.
#[tauri::command]
async fn grid_save(request: Request<'_>) -> Result<(), String> {
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

/// Per Finder (Doppelklick, „Öffnen mit“) angeforderte Datei, bis die Oberfläche sie abgeholt hat
/// (beim Kaltstart kommt das Ereignis vor dem ersten Rendern).
#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
  state.0.lock().ok().and_then(|mut p| p.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(PendingOpen::default())
    .invoke_handler(tauri::generate_handler![grid_save, grid_open, take_pending_open])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Menüleiste: Datei-Befehle gehen als Ereignis „menu“ an die Oberfläche.
      let item = |id: &str, text: &str, accel: &str| MenuItemBuilder::with_id(id, text).accelerator(accel).build(app);
      let file = SubmenuBuilder::new(app, "Ablage")
        .item(&item("new", "Neu …", "CmdOrCtrl+N")?)
        .item(&item("open", "Öffnen …", "CmdOrCtrl+O")?)
        .separator()
        .item(&item("save", "Sichern", "CmdOrCtrl+S")?)
        .item(&item("save_as", "Sichern unter …", "CmdOrCtrl+Shift+S")?)
        .separator()
        .close_window()
        .build()?;
      let edit = SubmenuBuilder::new(app, "Bearbeiten")
        .undo().redo().separator().cut().copy().paste().select_all()
        .build()?;
      let app_menu = SubmenuBuilder::new(app, "Grid")
        .about(None).separator().hide().hide_others().show_all().separator().quit()
        .build()?;
      let window = SubmenuBuilder::new(app, "Fenster").minimize().maximize().build()?;
      app.set_menu(MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &window]).build()?)?;
      Ok(())
    })
    .on_menu_event(|app, event| {
      let _ = app.emit("menu", event.id().as_ref());
    })
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
