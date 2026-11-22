//! Freier Speicherplatz auf dem Datenträger des Servers: Ist er knapp, nimmt der Server nichts Neues mehr an,
//! damit weder die Datenbank noch der Rechner volllaufen.

use std::{path::Path, sync::Mutex, time::{Duration, Instant}};

/// Freier Platz für unprivilegierte Prozesse in Bytes (`None`, wenn er sich nicht ermitteln lässt).
#[cfg(unix)]
pub fn free_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 { return None; }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}
#[cfg(not(unix))]
pub fn free_bytes(_dir: &Path) -> Option<u64> { None }

/// Gesamtgröße des Datenträgers in Bytes.
#[cfg(unix)]
pub fn total_bytes(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 { return None; }
    Some(st.f_blocks as u64 * st.f_frsize as u64)
}
#[cfg(not(unix))]
pub fn total_bytes(_dir: &Path) -> Option<u64> { None }

/// Merkt sich die Messung kurz, damit nicht jede Nachricht den Datenträger abfragt.
pub struct Watch { dir: std::path::PathBuf, last: Mutex<Option<(Instant, Option<u64>)>> }

impl Watch {
    pub fn new(dir: &Path) -> Watch { Watch { dir: dir.to_path_buf(), last: Mutex::new(None) } }

    pub fn free(&self) -> Option<u64> {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((t, v)) = *last { if t.elapsed() < Duration::from_secs(20) { return v; } }
        let v = free_bytes(&self.dir);
        *last = Some((Instant::now(), v));
        v
    }
}
