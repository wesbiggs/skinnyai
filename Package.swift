// swift-tools-version:5.9
// Builds the macOS app's native shell (macos/main.swift); scripts/build-app.sh
// wraps the result into dist/SkinnyAI.app. The chat itself is the skinnyai
// binary, hosted in a SwiftTerm terminal view.
import PackageDescription

let package = Package(
    name: "SkinnyAI",
    platforms: [.macOS(.v13)],
    dependencies: [
        // Pinned to a main commit for the wide-character reflow fix; switch back to `from:` once a release includes it.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", revision: "4d5eeea89ed7c0fabffea9c8415cc392a6a06a31"),
    ],
    targets: [
        .executableTarget(
            name: "SkinnyAI",
            dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")],
            path: "macos",
            exclude: ["Info.plist", "entitlements.plist", "AppIcon.icns"]
        ),
    ]
)
