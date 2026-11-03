import Cocoa

/// The address bar in the title bar: a quiet rounded field with the path of screens as
/// breadcrumbs (AI UI › Play › Games); each part is clickable and jumps to that level.
final class AddressBar: NSView {
    var onSelect: ((Int) -> Void)?
    private let stack = NSStackView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 7
        stack.orientation = .horizontal
        stack.spacing = 5
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        // A path, left-aligned (like Finder/Xcode): starts right after the window buttons.
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            heightAnchor.constraint(equalToConstant: 22),
            widthAnchor.constraint(lessThanOrEqualToConstant: 720),
        ])
        set(["AI UI"])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.clear.cgColor   // a plain path, no field
    }

    func set(_ items: [String]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, title) in items.enumerated() {
            if i > 0 {
                let sep = NSTextField(labelWithString: "›")
                sep.font = NSFont.titleBarFont(ofSize: 13)
                sep.textColor = .tertiaryLabelColor
                stack.addArrangedSubview(sep)
            }
            // Plain labels (no button bezel/padding), all in the system title-bar font: the current place
            // like a window title, the levels above it quieter. Each is clickable.
            let last = i == items.count - 1
            let label = ClickLabel(labelWithString: title)
            label.tag = i
            label.font = NSFont.titleBarFont(ofSize: 13)
            label.textColor = last ? .labelColor : .secondaryLabelColor
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            label.toolTip = title
            label.onClick = { [weak self] in self?.onSelect?(i) }
            stack.addArrangedSubview(label)
        }
    }

    @objc private func clicked(_ sender: NSButton) { onSelect?(sender.tag) }
}

/// A label that reports clicks (and shows the pointing hand).
final class ClickLabel: NSTextField {
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onClick?() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}
