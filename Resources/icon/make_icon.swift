// Renders the AI UI app icon (1024px PNG): a circle with its two ears, × and +.
// Usage: swift make_icon.swift out.png
import AppKit

let S: CGFloat = 1024
let out = CommandLine.arguments[1]
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(red: r/255, green: g/255, blue: b/255, alpha: a) }
let space = CGColorSpaceCreateDeviceRGB()

// Squircle tile (macOS grid: 824px tile centred, ~185px corner radius), with a soft drop shadow.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0, 0, 0, 0.35))
ctx.addPath(tilePath); ctx.setFillColor(rgb(11, 11, 15)); ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(tilePath); ctx.clip()
let bg = CGGradient(colorsSpace: space, colors: [rgb(30, 34, 54), rgb(11, 11, 15)] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
// accent glow behind the circle
let glow = CGGradient(colorsSpace: space, colors: [rgb(124, 156, 255, 0.38), rgb(124, 156, 255, 0)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 470), startRadius: 0, endCenter: CGPoint(x: 512, y: 470), endRadius: 380, options: [])
ctx.restoreGState()

// Main circle
let c = CGPoint(x: 512, y: 470), R: CGFloat = 220
let circle = CGRect(x: c.x - R, y: c.y - R, width: 2 * R, height: 2 * R)
ctx.saveGState()
ctx.addEllipse(in: circle); ctx.clip()
let face = CGGradient(colorsSpace: space, colors: [rgb(124, 156, 255, 0.55), rgb(124, 156, 255, 0.10)] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(face, startCenter: CGPoint(x: c.x - 70, y: c.y + 90), startRadius: 0, endCenter: c, endRadius: R * 1.2, options: [.drawsAfterEndLocation])
ctx.restoreGState()
ctx.setStrokeColor(rgb(124, 156, 255)); ctx.setLineWidth(16)
ctx.strokeEllipse(in: circle.insetBy(dx: 8, dy: 8))

// Ears at ~45° up-left (×) and up-right (+)
let r: CGFloat = 74
for (sign, plus) in [(-1.0, false), (1.0, true)] as [(CGFloat, Bool)] {
    let a = CGFloat.pi / 4
    let e = CGPoint(x: c.x + sign * (R + 18) * cos(a), y: c.y + (R + 18) * sin(a))
    let er = CGRect(x: e.x - r, y: e.y - r, width: 2 * r, height: 2 * r)
    ctx.setFillColor(rgb(21, 21, 28)); ctx.fillEllipse(in: er)
    ctx.setStrokeColor(rgb(255, 255, 255, 0.22)); ctx.setLineWidth(6); ctx.strokeEllipse(in: er.insetBy(dx: 3, dy: 3))
    ctx.setStrokeColor(plus ? rgb(124, 156, 255) : rgb(232, 232, 238)); ctx.setLineWidth(15); ctx.setLineCap(.round)
    let k: CGFloat = 30
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

// "AI" inside the circle
let para = NSMutableParagraphStyle(); para.alignment = .center
let font = NSFont.systemFont(ofSize: 150, weight: .semibold)
let text = NSAttributedString(string: "AI", attributes: [.font: font, .foregroundColor: NSColor(white: 0.96, alpha: 1), .paragraphStyle: para, .kern: 4])
let th = text.size().height
text.draw(in: CGRect(x: c.x - R, y: c.y - th / 2 - 6, width: 2 * R, height: th))

// Go pill below
let pill = CGRect(x: 512 - 92, y: 168, width: 184, height: 60)
ctx.addPath(CGPath(roundedRect: pill, cornerWidth: 30, cornerHeight: 30, transform: nil))
ctx.setFillColor(rgb(124, 156, 255)); ctx.fillPath()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
