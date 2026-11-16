// swift-tools-version:5.9
// AI UI OS installer tools: preflight, install planner (dry-run) and uninstaller (README.md).
import PackageDescription

let package = Package(
    name: "os-installer",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "aiui-os", targets: ["aiui-os"]),
        .library(name: "OSInstallerCore", targets: ["OSInstallerCore"]),
    ],
    targets: [
        .target(name: "OSInstallerCore"),
        .executableTarget(name: "aiui-os", dependencies: ["OSInstallerCore"]),
        .testTarget(name: "OSInstallerCoreTests", dependencies: ["OSInstallerCore"]),
    ]
)
