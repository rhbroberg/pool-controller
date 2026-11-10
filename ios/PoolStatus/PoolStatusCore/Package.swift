// swift-tools-version: 6.2
import PackageDescription

/// The app's models, stores and API client, kept free of SwiftUI so they're tested without the app.
let isolation: [SwiftSetting] = [
    .defaultIsolation(MainActor.self),
    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
    .enableUpcomingFeature("InferIsolatedConformances"),
    .enableUpcomingFeature("MemberImportVisibility")
]

let package = Package(
    name: "PoolStatusCore",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .watchOS(.v10), .macOS(.v14)],
    products: [
        .library(name: "PoolStatusCore", targets: ["PoolStatusCore"])
    ],
    targets: [
        .target(name: "PoolStatusCore",
                resources: [.process("Localizable.xcstrings")],
                swiftSettings: isolation),
        .testTarget(name: "PoolStatusCoreTests",
                    dependencies: ["PoolStatusCore"],
                    swiftSettings: isolation)
    ]
)
