//! Eigenheiten der Webansicht auf iPad und iPhone, die nur nativ erreichbar sind. Anderswo tun die Befehle nichts.

/// Achsensperre: Beginnt eine Wischgeste deutlich senkrecht (oder waagerecht), bleibt sie dabei. So treibt eine lange Tabelle
/// beim schnellen Blättern nicht zur Seite. Beginnt die Geste schräg, geht es weiter in beide Richtungen.
///
/// Per CSS ist das nicht zu haben. WebKit legt für jeden scrollbaren Bereich der Seite eine eigene `UIScrollView` an; hier
/// bekommen alle den Schalter von iOS. Dieser innere Aufbau ist nicht dokumentiert: Ändert ihn ein iOS-Update, findet die
/// Suche eben nichts, und es scrollt sich wie ohne Sperre. Die Oberfläche ruft den Befehl bei jeder Berührung auf, weil die
/// Ansichten erst bei Bedarf entstehen.
#[tauri::command]
pub fn lock_scroll_axes(window: tauri::WebviewWindow) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  window
    .with_webview(|view| unsafe { ios::lock(view.inner() as *mut objc2::runtime::AnyObject) })
    .map_err(|e| e.to_string())?;
  #[cfg(not(target_os = "ios"))]
  let _ = window;
  Ok(())
}

#[cfg(target_os = "ios")]
mod ios {
  use objc2::{class, msg_send, runtime::AnyObject};

  /// Alle Scrollansichten unter `view` (einschließlich) sperren. Läuft auf dem Haupt-Thread.
  pub unsafe fn lock(view: *mut AnyObject) {
    unsafe {
      let scrolls: bool = msg_send![view, isKindOfClass: class!(UIScrollView)];
      if scrolls {
        let locked: bool = msg_send![view, isDirectionalLockEnabled];
        if !locked {
          let _: () = msg_send![view, setDirectionalLockEnabled: true];
        }
      }
      let children: *mut AnyObject = msg_send![view, subviews];
      let count: usize = msg_send![children, count];
      for i in 0..count {
        let child: *mut AnyObject = msg_send![children, objectAtIndex: i];
        lock(child);
      }
    }
  }
}
