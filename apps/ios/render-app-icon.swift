#!/usr/bin/env swift
// Renders the iOS app icon from the macOS one (apps/macos/dmg/render-artwork.swift draws it):
// the macOS icon is a 824 pt tile with a shadow on a transparent 1024 pt canvas; iOS wants an
// opaque, full-bleed square (the system applies the mask). The tile is cropped, scaled to 1024 px
// and drawn onto the tile's own teal gradient, so the result has no alpha and no seams.
// Run from apps/ios:  swift render-app-icon.swift
import AppKit
import CoreGraphics
import Foundation

let fm = FileManager.default
let root = URL(fileURLWithPath: fm.currentDirectoryPath)
let source = root.appending(path: "../macos/Synclet/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png")
let target = root.appending(path: "Synclet/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png")
guard fm.fileExists(atPath: source.path), fm.fileExists(atPath: target.deletingLastPathComponent().path) else {
    fatalError("run from apps/ios")
}

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

// The macOS tile (render-artwork.swift): rect 100…924, corner radius 185, gradient top → bottom.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tileRadius: CGFloat = 185
let tealLight = rgb(0x2DD4BF), tealDark = rgb(0x0E7490)

guard let data = try? Data(contentsOf: source), let provider = CGDataProvider(data: data as CFData),
      let image = CGImage(pngDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent),
      image.width == 1024 else { fatalError("can't read \(source.path)") }

let size = 1024
// No alpha channel at all.
let g = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
g.interpolationQuality = .high

// Background: the tile's gradient, full bleed.
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: [tealLight, tealDark] as CFArray, locations: [0, 1])!
g.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 1024), end: CGPoint(x: 512, y: 0), options: [])

// The tile's inside (without its shadow), scaled so the tile fills the square.
let scale = CGFloat(size) / tile.width
let cropped = image.cropping(to: CGRect(x: tile.minX, y: CGFloat(image.height) - tile.maxY,
                                        width: tile.width, height: tile.height))!
g.saveGState()
// Clipped a few pixels inside the tile's anti-aliased edge (it carries the shadow's colour); the
// background gradient is the tile's, scaled the same way, so the rim is seamless.
let inset: CGFloat = 8
g.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: size, height: size).insetBy(dx: inset, dy: inset),
                 cornerWidth: tileRadius * scale - inset, cornerHeight: tileRadius * scale - inset, transform: nil))
g.clip()
g.draw(cropped, in: CGRect(x: 0, y: 0, width: size, height: size))
g.restoreGState()

let rep = NSBitmapImageRep(cgImage: g.makeImage()!)
guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("PNG encoding failed") }
try png.write(to: target)
print("wrote \(target.path) (\(size)×\(size), opaque)")
