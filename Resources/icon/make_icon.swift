// Renders the AI UI app icon (1024px PNG) in the app's own style: the light theme's soft grey,
// a grid of white circles with hairline borders, and the focused one in front — accent focus
// ring and its two ear chips, × and +, exactly as they look in the UI.
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

// App palette (light theme).
let bgTop = rgb(250, 250, 252), bgBottom = rgb(236, 237, 243)
let face = rgb(255, 255, 255), line = rgb(0, 0, 0, 0.08)
let accent = rgb(74, 108, 247), danger = rgb(224, 68, 90), muted = rgb(107, 107, 123)

// Tile: macOS grid (824px squircle centred, soft shadow); iOS: full bleed (the system masks it).
if square {
    ctx.translateBy(x: 512, y: 512); ctx.scaleBy(x: 1024 / 824, y: 1024 / 824); ctx.translateBy(x: -512, y: -512)
}
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = square ? CGPath(rect: tile.insetBy(dx: -40, dy: -40), transform: nil)
                      : CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
if !square {
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(20, 20, 40, 0.28))
    ctx.addPath(tilePath); ctx.setFillColor(bgBottom); ctx.fillPath()
    ctx.restoreGState()
}
ctx.saveGState()
ctx.addPath(tilePath); ctx.clip()
let bg = CGGradient(colorsSpace: space, colors: [bgTop, bgBottom] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 960), end: CGPoint(x: 512, y: 60), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

/// A circle as the UI draws it: white face, hairline border, soft two-layer shadow.
func uiCircle(_ c: CGPoint, _ r: CGFloat, alpha: CGFloat = 1) {
    let rect = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
    ctx.saveGState()
    ctx.setAlpha(alpha)
    ctx.setShadow(offset: CGSize(width: 0, height: -r * 0.12), blur: r * 0.35, color: rgb(20, 20, 40, 0.10))
    ctx.setFillColor(face); ctx.fillEllipse(in: rect)
    ctx.restoreGState()
    ctx.saveGState()
    ctx.setAlpha(alpha)
    ctx.setStrokeColor(line); ctx.setLineWidth(max(2, r * 0.025)); ctx.strokeEllipse(in: rect.insetBy(dx: 1, dy: 1))
    ctx.restoreGState()
}

// The grid behind: a 3×3 of circles like a screen of the app, fading toward the edges.
let step: CGFloat = 250, gr: CGFloat = 92
for row in -1...1 {
    for col in -1...1 where !(row == 0 && col == 0) {
        let p = CGPoint(x: 512 + CGFloat(col) * step, y: 512 + CGFloat(row) * step)
        uiCircle(p, gr, alpha: (row == 0 || col == 0) ? 0.95 : 0.75)
    }
}

// The focused circle in front: bigger, accent focus ring with a gap (like outline-offset).
let c = CGPoint(x: 512, y: 512), R: CGFloat = 178
uiCircle(c, R)
ctx.setStrokeColor(accent); ctx.setLineWidth(15)
let ringR = R + 34
ctx.strokeEllipse(in: CGRect(x: c.x - ringR, y: c.y - ringR, width: 2 * ringR, height: 2 * ringR))

// Inside the focused circle: a small grid of circles — the app in miniature.
let g: CGFloat = 54, dr: CGFloat = 36
for (dx, dy, a) in [(-g, g, 1.0), (g, g, 0.35), (-g, -g, 0.35), (g, -g, 0.35)] as [(CGFloat, CGFloat, CGFloat)] {
    let p = CGPoint(x: c.x + dx, y: c.y + dy)
    ctx.setFillColor(accent.copy(alpha: a)!)
    ctx.fillEllipse(in: CGRect(x: p.x - dr, y: p.y - dr, width: 2 * dr, height: 2 * dr))
}

// Ear chips at ~45° up-left (×, danger) and up-right (+, accent): white chips with a hairline.
let er: CGFloat = 62
for (sign, plus) in [(-1.0, false), (1.0, true)] as [(CGFloat, Bool)] {
    let a = CGFloat.pi / 4
    let e = CGPoint(x: c.x + sign * (R + 10) * cos(a), y: c.y + (R + 10) * sin(a))
    uiCircle(e, er)
    ctx.setStrokeColor(plus ? accent : danger); ctx.setLineWidth(13); ctx.setLineCap(.round)
    let k: CGFloat = 24
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
_ = muted
ctx.restoreGState()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
