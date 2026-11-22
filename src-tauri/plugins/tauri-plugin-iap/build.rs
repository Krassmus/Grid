const COMMANDS: &[&str] = &["products", "purchase", "current", "restore"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .ios_path("ios")
    .build();
}
