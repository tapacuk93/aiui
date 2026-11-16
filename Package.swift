// swift-tools-version:5.9
// Test harness only: the Mac app is built by build.sh (swiftc + CEF) and the iOS app by the
// Xcode project from project.yml. This package compiles the same Sources/App and Sources/Mac
// files as a library, against a recording stub of the CEF bridge (Tests/CefStub), so XCTest can
// run them with coverage: tools/coverage/swift.sh.
import PackageDescription
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "AIUI",
    platforms: [.macOS("13.0")],
    targets: [
        // The Objective-C face of CEF (Sources/Native/AIUICef.h) with a do-nothing, call-recording body.
        .target(name: "AIUICefStub", path: "Tests/CefStub", publicHeadersPath: "include",
                cSettings: [.unsafeFlags(["-fobjc-arc"])]),
        .target(
            name: "AIUI",
            dependencies: ["AIUICefStub"],
            path: "Sources",
            exclude: ["iOS", "Native", "Mac/main.swift"],
            swiftSettings: [.unsafeFlags(["-import-objc-header", root + "/Sources/Native/AIUICef.h"])],
            linkerSettings: [.linkedFramework("CoreWLAN"), .linkedFramework("Security")]
        ),
        .testTarget(name: "AIUITests", dependencies: ["AIUI"], path: "Tests/AIUITests"),
    ]
)
