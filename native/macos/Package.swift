// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "screenrec-mac",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "screenrec-mac", path: "Sources/screenrec-mac")]
)
