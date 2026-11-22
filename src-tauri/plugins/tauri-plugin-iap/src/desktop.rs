use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<Iap<R>> {
  Ok(Iap(app.clone()))
}

/// Auf dem Desktop gibt es (noch) keinen App-Store-Kauf: die Befehle melden das, die Oberfläche zeigt sie gar nicht erst an.
pub struct Iap<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Iap<R> {
  pub fn products(&self, _: ProductsRequest) -> crate::Result<ProductsResponse> { Err(crate::Error::Unavailable) }
  pub fn purchase(&self, _: PurchaseRequest) -> crate::Result<PurchaseResponse> { Err(crate::Error::Unavailable) }
  pub fn current(&self) -> crate::Result<Transactions> { Err(crate::Error::Unavailable) }
  pub fn restore(&self) -> crate::Result<Transactions> { Err(crate::Error::Unavailable) }
}
