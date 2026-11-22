use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_iap);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Iap<R>> {
  // Nur iOS hat einen App Store, auf den wir hier zugreifen
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_iap)?;
  #[cfg(not(target_os = "ios"))]
  let handle = { let _ = api; return Err(crate::Error::Unavailable) };
  #[allow(unreachable_code)]
  Ok(Iap(handle))
}

/// Access to the iap APIs.
pub struct Iap<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Iap<R> {
  pub fn products(&self, payload: ProductsRequest) -> crate::Result<ProductsResponse> {
    self.0.run_mobile_plugin("products", payload).map_err(Into::into)
  }
  pub fn purchase(&self, payload: PurchaseRequest) -> crate::Result<PurchaseResponse> {
    self.0.run_mobile_plugin("purchase", payload).map_err(Into::into)
  }
  pub fn current(&self) -> crate::Result<Transactions> {
    self.0.run_mobile_plugin("current", Empty {}).map_err(Into::into)
  }
  pub fn restore(&self) -> crate::Result<Transactions> {
    self.0.run_mobile_plugin("restore", Empty {}).map_err(Into::into)
  }
}
