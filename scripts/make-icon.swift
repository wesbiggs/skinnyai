#!/usr/bin/env swift
// Renders macos/AppIcon.icns: "SKINNY" in a thin weight and "AI" in bold,
// terminal green on dark grey. Run: swift scripts/make-icon.swift
import AppKit

let canvas: CGFloat = 1024
let body = NSRect(x: 100, y: 100, width: 824, height: 824) // macOS icon grid
let green = NSColor(srgbRed: 0x5f / 255, green: 0xff / 255, blue: 0x5f / 255, alpha: 1) // the default model color (xterm 83)

func render(size: Int) -> Data {
    let image = NSImage(size: NSSize(width: canvas, height: canvas), flipped: false) { _ in
        NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185).fill()

        let font = { (weight: NSFont.Weight) in NSFont.systemFont(ofSize: 160, weight: weight) }
        let text = NSMutableAttributedString()
        text.append(NSAttributedString(string: "SKINNY", attributes: [.font: font(.ultraLight), .foregroundColor: green, .kern: 1.5]))
        text.append(NSAttributedString(string: "AI", attributes: [.font: font(.black), .foregroundColor: green, .kern: 1.5]))
        let size = text.size()
        text.draw(at: NSPoint(x: (canvas - size.width) / 2, y: (canvas - size.height) / 2 + 4))
        return true
    }
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let iconset = URL(fileURLWithPath: "build/AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try render(size: base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try render(size: base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", "macos/AppIcon.icns"]
try process.run()
process.waitUntilExit()
try render(size: 1024).write(to: URL(fileURLWithPath: "build/AppIcon-preview.png"))
