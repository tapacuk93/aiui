// Renders the AI UI app icon (1024px PNG): a field of circles on an indigo→violet tile, the
// focused one in front with its focus ring and its two ears, × and +.
// Usage: swift make_icon.swift out.png [--square]   (--square: opaque full-bleed, for iOS)
import AppKit

let S: CGFloat = 1024
let out = CommandLine.arguments[1]
let square = CommandLine.arguments.contains("--square")
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(red: r/255, green: g/255, blue: b/255, alpha: a) }
let space = CGColorSpaceCreateDeviceRGB()

// Tile: macOS grid (824px squircle centred, soft shadow); iOS: full bleed (the system masks it).
if square {
    ctx.translateBy(x: 512, y: 512); ctx.scaleBy(x: 1024 / 824, y: 1024 / 824); ctx.translateBy(x: -512, y: -512)
}
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = square ? CGPath(rect: tile.insetBy(dx: -40, dy: -40), transform: nil)
                      : CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
if !square {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: rgb(20, 10, 60, 0.35))
    ctx.addPath(tilePath); ctx.setFillColor(rgb(80, 90, 240)); ctx.fillPath()
    ctx.restoreGState()
}
ctx.saveGState()
ctx.addPath(tilePath); ctx.clip()
let bg = CGGradient(colorsSpace: space, colors: [rgb(92, 120, 255), rgb(124, 84, 245), rgb(150, 70, 220)] as CFArray,
                    locations: [0, 0.6, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 140, y: 900), end: CGPoint(x: 900, y: 120), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
let sheen = CGGradient(colorsSpace: space, colors: [rgb(255, 255, 255, 0.28), rgb(255, 255, 255, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(sheen, startCenter: CGPoint(x: 300, y: 820), startRadius: 0, endCenter: CGPoint(x: 300, y: 820), endRadius: 560, options: [])

func circle(_ c: CGPoint, _ r: CGFloat, fill: CGColor, stroke: CGColor? = nil, width: CGFloat = 0) {
    let rect = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
    ctx.setFillColor(fill); ctx.fillEllipse(in: rect)
    if let stroke { ctx.setStrokeColor(stroke); ctx.setLineWidth(width); ctx.strokeEllipse(in: rect.insetBy(dx: width / 2, dy: width / 2)) }
}

// The field: smaller circles behind, fading toward the edges.
let field: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
    (250, 735, 78, 0.20), (774, 760, 64, 0.16), (232, 300, 62, 0.15),
    (790, 285, 86, 0.22), (512, 175, 46, 0.13), (165, 515, 40, 0.12), (865, 525, 44, 0.12),
]
for (x, y, r, a) in field { circle(CGPoint(x: x, y: y), r, fill: rgb(255, 255, 255, a)) }

// The focused circle: white, soft shadow, focus ring around it.
let c = CGPoint(x: 512, y: 500), R: CGFloat = 196
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 40, color: rgb(40, 20, 110, 0.45))
circle(c, R, fill: rgb(255, 255, 255))
ctx.restoreGState()
let face = CGGradient(colorsSpace: space, colors: [rgb(255, 255, 255), rgb(232, 234, 255)] as CFArray, locations: [0, 1])!
ctx.saveGState()
ctx.addEllipse(in: CGRect(x: c.x - R, y: c.y - R, width: 2 * R, height: 2 * R)); ctx.clip()
ctx.drawLinearGradient(face, start: CGPoint(x: c.x, y: c.y + R), end: CGPoint(x: c.x, y: c.y - R), options: [])
ctx.restoreGState()
ctx.setStrokeColor(rgb(255, 255, 255, 0.9)); ctx.setLineWidth(14)
ctx.strokeEllipse(in: CGRect(x: c.x - R - 34, y: c.y - R - 34, width: 2 * (R + 34), height: 2 * (R + 34)))

// Inside: a small cluster of dots — circles within the circle.
let ink = rgb(110, 92, 245)
for (dx, dy, r, a) in [(-62.0, 30.0, 34.0, 1.0), (54.0, 46.0, 26.0, 0.75), (8.0, -58.0, 30.0, 0.55)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
    circle(CGPoint(x: c.x + dx, y: c.y + dy), r, fill: ink.copy(alpha: a)!)
}

// Ears at ~45° up-left (×) and up-right (+).
let er: CGFloat = 70
for (sign, plus) in [(-1.0, false), (1.0, true)] as [(CGFloat, Bool)] {
    let a = CGFloat.pi / 4
    let e = CGPoint(x: c.x + sign * (R + 34) * cos(a), y: c.y + (R + 34) * sin(a))
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: rgb(40, 20, 110, 0.35))
    circle(e, er, fill: rgb(255, 255, 255))
    ctx.restoreGState()
    ctx.setStrokeColor(plus ? ink : rgb(235, 80, 110)); ctx.setLineWidth(16); ctx.setLineCap(.round)
    let k: CGFloat = 28
    if plus {
        ctx.move(to: CGPoint(x: e.x - k, y: e.y)); ctx.addLine(to: CGPoint(x: e.x + k, y: e.y))
        ctx.move(to: CGPoint(x: e.x, y: e.y - k)); ctx.addLine(to: CGPoint(x: e.x, y: e.y + k))
    } else {
        let d = k * 0.78
        ctx.move(to: CGPoint(x: e.x - d, y: e.y - d)); ctx.addLine(to: CGPoint(x: e.x + d, y: e.y + d))
        ctx.move(to: CGPoint(x: e.x - d, y: e.y + d)); ctx.addLine(to: CGPoint(x: e.x + d, y: e.y - d))
    }
    ctx.strokePath()
}
ctx.restoreGState()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
