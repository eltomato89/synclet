#!/usr/bin/env swift
// Renders Synclet's artwork with CoreGraphics (vector shapes, every size drawn natively):
// - the app icon set   → Synclet/Resources/Assets.xcassets/AppIcon.appiconset/icon_<px>.png
// - the volume icon    → dmg/VolumeIcon.icns (via iconutil)
// - the DMG background → dmg/background.png (660×400) and dmg/background@2x.png
// Run from apps/macos:  swift dmg/render-artwork.swift
// Motif: a white folder with two circling arrows on a teal tile – "a folder that stays in sync".
import AppKit
import CoreGraphics
import Foundation

let fm = FileManager.default
let root = URL(fileURLWithPath: fm.currentDirectoryPath)
let iconSet = root.appending(path: "Synclet/Resources/Assets.xcassets/AppIcon.appiconset")
let dmgDir = root.appending(path: "dmg")
guard fm.fileExists(atPath: iconSet.path) else { fatalError("run from apps/macos") }

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

let tealLight = rgb(0x2DD4BF), tealDark = rgb(0x0E7490), ink = rgb(0x0F5F6E)

func bitmap(_ width: Int, _ height: Int) -> CGContext {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    context.setShouldAntialias(true)
    return context
}

func writePNG(_ context: CGContext, to url: URL) {
    let rep = NSBitmapImageRep(cgImage: context.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: url)
}

/// Two arcs with arrowheads (clockwise), centred at `c`, radius `r`, line width `w`.
func drawSyncGlyph(_ g: CGContext, center c: CGPoint, radius r: CGFloat, width w: CGFloat, color: CGColor) {
    g.setStrokeColor(color)
    g.setFillColor(color)
    g.setLineWidth(w)
    g.setLineCap(.round)
    let head = w * 1.55
    for start in [CGFloat.pi * 0.98, -CGFloat.pi * 0.02] { // upper-left arc and lower-right arc
        let sweep = CGFloat.pi * 0.62
        let end = start - sweep // clockwise in a y-up context
        g.beginPath()
        g.addArc(center: c, radius: r, startAngle: start, endAngle: end + w / r * 0.9, clockwise: true)
        g.strokePath()
        // Arrowhead at `end`, pointing along the clockwise tangent.
        let tip = CGPoint(x: c.x + r * cos(end), y: c.y + r * sin(end))
        let tangent = CGPoint(x: sin(end), y: -cos(end)) // clockwise direction
        let normal = CGPoint(x: cos(end), y: sin(end))
        let back = CGPoint(x: tip.x - tangent.x * head * 1.05, y: tip.y - tangent.y * head * 1.05)
        g.beginPath()
        g.move(to: CGPoint(x: tip.x + tangent.x * head * 0.35, y: tip.y + tangent.y * head * 0.35))
        g.addLine(to: CGPoint(x: back.x + normal.x * head * 0.78, y: back.y + normal.y * head * 0.78))
        g.addLine(to: CGPoint(x: back.x - normal.x * head * 0.78, y: back.y - normal.y * head * 0.78))
        g.closePath()
        g.fillPath()
    }
}

/// The icon on a 1024-point canvas, scaled to `px`.
func renderIcon(px: Int) -> CGContext {
    let g = bitmap(px, px)
    let s = CGFloat(px) / 1024
    g.scaleBy(x: s, y: s)

    // Tile (macOS grid: 824 pt, corner radius ~185 pt), soft shadow, vertical gradient.
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
    g.saveGState()
    g.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x000000, 0.28))
    g.addPath(tilePath)
    g.setFillColor(tealDark)
    g.fillPath()
    g.restoreGState()
    g.saveGState()
    g.addPath(tilePath)
    g.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                              colors: [tealLight, tealDark] as CFArray, locations: [0, 1])!
    g.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
    g.restoreGState()

    // Folder: back panel with tab (slightly transparent), front panel white.
    let back = CGMutablePath()
    back.addRoundedRect(in: CGRect(x: 232, y: 270, width: 560, height: 420), cornerWidth: 44, cornerHeight: 44)
    back.addRoundedRect(in: CGRect(x: 232, y: 640, width: 236, height: 96), cornerWidth: 36, cornerHeight: 36)
    g.addPath(back)
    g.setFillColor(rgb(0xFFFFFF, 0.72))
    g.fillPath()
    g.saveGState()
    g.setShadow(offset: CGSize(width: 0, height: -6), blur: 14, color: rgb(0x0B3B44, 0.25))
    g.addPath(CGPath(roundedRect: CGRect(x: 232, y: 270, width: 560, height: 370), cornerWidth: 44, cornerHeight: 44, transform: nil))
    g.setFillColor(rgb(0xFFFFFF))
    g.fillPath()
    g.restoreGState()

    // Sync glyph on the front panel.
    drawSyncGlyph(g, center: CGPoint(x: 512, y: 455), radius: 104, width: 34, color: ink)
    return g
}

// App icon set (sizes referenced by Contents.json).
for px in [16, 32, 64, 128, 256, 512, 1024] {
    writePNG(renderIcon(px: px), to: iconSet.appending(path: "icon_\(px).png"))
}

// Volume icon (.icns) through a temporary .iconset.
let tmp = fm.temporaryDirectory.appending(path: "synclet-volicon-\(UUID().uuidString).iconset")
try! fm.createDirectory(at: tmp, withIntermediateDirectories: true)
for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    writePNG(renderIcon(px: px), to: tmp.appending(path: "icon_\(name).png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", tmp.path, "-o", dmgDir.appending(path: "VolumeIcon.icns").path]
try! iconutil.run()
iconutil.waitUntilExit()
try? fm.removeItem(at: tmp)
precondition(iconutil.terminationStatus == 0, "iconutil failed")

// DMG background: light, an arrow from the app (left, x 170) to Applications (right, x 490),
// icons at y 190 (Finder coordinates from the top) – matches build_and_notarize.sh.
func renderBackground(scale: Int) -> CGContext {
    let w = 660, h = 400
    let g = bitmap(w * scale, h * scale)
    g.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                              colors: [rgb(0xF4FBFA), rgb(0xE3F2F1)] as CFArray, locations: [0, 1])!
    g.drawLinearGradient(gradient, start: CGPoint(x: 0, y: CGFloat(h)), end: .zero, options: [])
    // Arrow between the icon slots (y-up: 400 - 190 = 210).
    let y: CGFloat = 210
    g.setStrokeColor(rgb(0x0E7490, 0.55))
    g.setFillColor(rgb(0x0E7490, 0.55))
    g.setLineWidth(6)
    g.setLineCap(.round)
    g.setLineDash(phase: 0, lengths: [2, 14])
    g.move(to: CGPoint(x: 262, y: y))
    g.addLine(to: CGPoint(x: 384, y: y))
    g.strokePath()
    g.setLineDash(phase: 0, lengths: [])
    g.move(to: CGPoint(x: 404, y: y))
    g.addLine(to: CGPoint(x: 382, y: y + 15))
    g.addLine(to: CGPoint(x: 382, y: y - 15))
    g.closePath()
    g.fillPath()
    // Caption (de + en).
    let text = NSAttributedString(string: "Synclet in den Programme-Ordner ziehen · Drag Synclet to Applications",
                                  attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium),
                                               .foregroundColor: NSColor(cgColor: rgb(0x0F5F6E, 0.8))!])
    let line = CTLineCreateWithAttributedString(text)
    let bounds = CTLineGetBoundsWithOptions(line, [])
    g.textPosition = CGPoint(x: (CGFloat(w) - bounds.width) / 2, y: 62)
    CTLineDraw(line, g)
    return g
}
writePNG(renderBackground(scale: 1), to: dmgDir.appending(path: "background.png"))
writePNG(renderBackground(scale: 2), to: dmgDir.appending(path: "background@2x.png"))
print("artwork written")
