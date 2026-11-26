//! Drucken der Oberfläche. `window.print()` tut in der Webansicht von macOS und iPadOS nichts, und Tauris eingebautes Drucken
//! gibt es nur am Schreibtisch (dort ohne Seitenränder). Darum hier der native Weg mit Rändern. Was gedruckt wird, bestimmt
//! `@media print` der Oberfläche.

/// Seitenrand in Punkt (1/72 Zoll), rund 18 mm
#[cfg(any(target_os = "macos", target_os = "ios"))]
const MARGIN: f64 = 51.0;

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
  use objc2::{class, msg_send, rc::Retained, runtime::{AnyObject, Sel}};
  window
    .with_webview(|view| unsafe {
      let web = view.inner() as *mut AnyObject;
      let ns_window = view.ns_window() as *mut AnyObject;
      let shared: *mut AnyObject = msg_send![class!(NSPrintInfo), sharedPrintInfo];
      let info: Retained<AnyObject> = msg_send![shared, copy];
      let _: () = msg_send![&*info, setTopMargin: MARGIN];
      let _: () = msg_send![&*info, setBottomMargin: MARGIN];
      let _: () = msg_send![&*info, setLeftMargin: MARGIN];
      let _: () = msg_send![&*info, setRightMargin: MARGIN];
      let _: () = msg_send![&*info, setVerticallyCentered: false];
      let operation: Retained<AnyObject> = msg_send![web, printOperationWithPrintInfo: &*info];
      // Ohne eigene Größe bleiben die Seiten der Webansicht leer
      let bounds: objc2_foundation::NSRect = msg_send![web, bounds];
      let page: *mut AnyObject = msg_send![&*operation, view];
      let _: () = msg_send![page, setFrame: bounds];
      let none: *mut AnyObject = std::ptr::null_mut();
      let context: *mut std::ffi::c_void = std::ptr::null_mut();
      let selector: Option<Sel> = None;
      let _: () = msg_send![&*operation, runOperationModalForWindow: ns_window, delegate: none, didRunSelector: selector, contextInfo: context];
    })
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
  use objc2::{class, msg_send, runtime::{AnyObject, Bool}, Encode, Encoding};
  use objc2_foundation::{NSPoint, NSRect, NSSize};

  #[repr(C)]
  #[derive(Clone, Copy)]
  struct EdgeInsets { top: f64, left: f64, bottom: f64, right: f64 }
  // Aufbau wie UIEdgeInsets (vier CGFloat)
  unsafe impl Encode for EdgeInsets {
    const ENCODING: Encoding = Encoding::Struct("UIEdgeInsets", &[f64::ENCODING, f64::ENCODING, f64::ENCODING, f64::ENCODING]);
  }

  window
    .with_webview(|view| unsafe {
      let web = view.inner() as *mut AnyObject;
      let printer: *mut AnyObject = msg_send![class!(UIPrintInteractionController), sharedPrintController];
      let formatter: *mut AnyObject = msg_send![web, viewPrintFormatter];
      let insets = EdgeInsets { top: MARGIN, left: MARGIN, bottom: MARGIN, right: MARGIN };
      let _: () = msg_send![formatter, setPerPageContentInsets: insets];
      let _: () = msg_send![printer, setPrintFormatter: formatter];
      // Auf dem iPad erscheint der Druckdialog als Fenster über einer Stelle der Ansicht
      let bounds: NSRect = msg_send![web, bounds];
      let anchor = NSRect::new(NSPoint::new(bounds.size.width / 2.0, bounds.size.height - 60.0), NSSize::new(1.0, 1.0));
      let handler: *mut std::ffi::c_void = std::ptr::null_mut();
      let idiom: isize = {
        let device: *mut AnyObject = msg_send![class!(UIDevice), currentDevice];
        msg_send![device, userInterfaceIdiom]
      };
      let _: Bool = if idiom == 1 {
        msg_send![printer, presentFromRect: anchor, inView: web, animated: true, completionHandler: handler as *const block2::Block<dyn Fn(*mut AnyObject, Bool, *mut AnyObject)>]
      } else {
        msg_send![printer, presentAnimated: true, completionHandler: handler as *const block2::Block<dyn Fn(*mut AnyObject, Bool, *mut AnyObject)>]
      };
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
  window.print().map_err(|e| e.to_string())
}
