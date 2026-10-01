#!/usr/bin/env swift
// Renders macos/AppIcon.icns: "SKINNY" (white) stacked over "AI" (black, terminal green)
// on dark grey, each line stretched to the full width so it stays legible at Dock sizes.
// Run: swift scripts/make-icon.swift
import AppKit
import CoreText

let canvas: CGFloat = 1024
let body = NSRect(x: 100, y: 100, width: 824, height: 824) // macOS icon grid
let green = NSColor(srgbRed: 0x5f / 255, green: 0xff / 255, blue: 0x5f / 255, alpha: 1) // the default model color (xterm 83)

/// The outline of `string` in `weight`, scaled (not uniformly) to exactly fill `rect`.
func stretchedText(_ string: String, weight: NSFont.Weight, into rect: NSRect) -> NSBezierPath {
    let font = NSFont.systemFont(ofSize: 300, weight: weight) as CTFont
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: [.font: font]))
    let path = CGMutablePath()
    for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let count = CTRunGetGlyphCount(run)
        var glyphs = [CGGlyph](repeating: 0, count: count)
        var positions = [CGPoint](repeating: .zero, count: count)
        CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
        CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
        for (glyph, position) in zip(glyphs, positions) {
            if let outline = CTFontCreatePathForGlyph(font, glyph, nil) {
                path.addPath(outline, transform: CGAffineTransform(translationX: position.x, y: position.y))
            }
        }
    }
    let box = path.boundingBoxOfPath
    var fit = CGAffineTransform(translationX: -box.minX, y: -box.minY)
        .concatenating(CGAffineTransform(scaleX: rect.width / box.width, y: rect.height / box.height))
        .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    return NSBezierPath(cgPath: path.copy(using: &fit)!)
}

func render(size: Int) -> Data {
    let image = NSImage(size: NSSize(width: canvas, height: canvas), flipped: false) { _ in
        NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1).setFill()
        NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185).fill()

        let margin: CGFloat = 70
        let width = body.width - 2 * margin
        NSColor.white.setFill()
        stretchedText("SKINNY", weight: .regular, into: NSRect(x: body.minX + margin, y: 575, width: width, height: 190)).fill()
        green.setFill()
        stretchedText("AI", weight: .black, into: NSRect(x: body.minX + margin, y: 255, width: width, height: 290)).fill()
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
