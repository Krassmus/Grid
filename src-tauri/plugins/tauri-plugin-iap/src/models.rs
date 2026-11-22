use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductsRequest {
  pub ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInfo {
  pub id: String,
  pub name: String,
  pub description: String,
  /// Preis, so wie der App Store ihn anzeigt (z. B. „4,99 €“)
  pub price: String,
  /// Abrechnungszeitraum als ISO-Dauer (P1M, P1Y), leer ohne Abo
  pub period: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductsResponse {
  pub products: Vec<ProductInfo>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseRequest {
  pub product_id: String,
  /// Kennung des Grid-Kontos (UUID): steht danach in Apples signiertem Beleg und ordnet den Kauf dem Konto zu
  pub account_token: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseResponse {
  /// `success`, `pending` (wartet auf Genehmigung) oder `cancelled`
  pub status: String,
  /// Von Apple signierte Transaktion (JWS), nur bei `success`
  pub jws: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transactions {
  /// Alle gerade gültigen Transaktionen des Apple-Kontos als signierte Belege (JWS)
  pub transactions: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Empty {}
