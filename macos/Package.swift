// swift-tools-version:5.9
// Builds the macOS app's native shell (main.swift); scripts/build-app.sh
// wraps the result into dist/SkinnyAI.app. The chat itself is the skinnyai
// binary, hosted in a SwiftTerm terminal view.
import PackageDescription

let package = Package(
    name: "SkinnyAI",
    platforms: [.macOS(.v13)],
    dependencies: [
        // 1.99.0 is a pre-2.0 release (2.0 changes APIs); stay on it until the app is moved over deliberately.
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.0"),
    ],
    targets: [
        .executableTarget(
            name: "SkinnyAI",
            dependencies: [.product(name: "SwiftTerm", package: "SwiftTerm")],
            path: ".",
            sources: ["main.swift"]
        ),
    ]
)
