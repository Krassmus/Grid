use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::IapExt;
use crate::Result;

#[command]
pub(crate) async fn products<R: Runtime>(app: AppHandle<R>, payload: ProductsRequest) -> Result<ProductsResponse> {
  app.iap().products(payload)
}

#[command]
pub(crate) async fn purchase<R: Runtime>(app: AppHandle<R>, payload: PurchaseRequest) -> Result<PurchaseResponse> {
  app.iap().purchase(payload)
}

#[command]
pub(crate) async fn current<R: Runtime>(app: AppHandle<R>) -> Result<Transactions> {
  app.iap().current()
}

#[command]
pub(crate) async fn restore<R: Runtime>(app: AppHandle<R>) -> Result<Transactions> {
  app.iap().restore()
}
