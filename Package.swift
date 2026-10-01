// swift-tools-version:5.9
// Builds the macOS app's native shell (macos/main.swift); scripts/build-app.sh
// wraps the result into dist/SkinnyAI.app. The chat itself is the skinnyai
// binary, hosted in a SwiftTerm terminal view.
import PackageDescription

let package = Package(
    name: "SkinnyAI",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
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
