// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-iap",
    platforms: [
        .macOS("12.0"),
        .iOS("16.0"),
    ],
    products: [
        .library(
            name: "tauri-plugin-iap",
            type: .static,
            targets: ["tauri-plugin-iap"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-iap",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
