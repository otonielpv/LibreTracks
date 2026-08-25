// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "libretracks-ios-folder-picker",
  platforms: [.iOS(.v15)],
  products: [
    .library(
      name: "libretracks-ios-folder-picker",
      type: .static,
      targets: ["libretracks-ios-folder-picker"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "libretracks-ios-folder-picker",
      dependencies: [.byName(name: "Tauri")],
      path: "Sources")
  ]
)
