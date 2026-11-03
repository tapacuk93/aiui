import Cocoa

/// The address bar in the title bar: a quiet rounded field with the path of screens as
/// breadcrumbs (AI UI › Play › Games); each part is clickable and jumps to that level.
final class AddressBar: NSView {
    var onSelect: ((Int) -> Void)?
    /// The other paths from the root (shown after the active one): switch to one, or close it.
    var onSwitch: ((Int) -> Void)?
    var onClose: ((Int) -> Void)?
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

    func set(_ items: [String], others: [(String, String)] = []) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        defer { addOthers(others) }
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

    /// Each other path as a quiet tab: its last place (full path in the tooltip) and a ×.
    private func addOthers(_ others: [(String, String)]) {
        for (i, o) in others.enumerated() {
            let gap = NSTextField(labelWithString: "  ·  ")
            gap.font = NSFont.titleBarFont(ofSize: 13)
            gap.textColor = .quaternaryLabelColor
            stack.addArrangedSubview(gap)
            let label = ClickLabel(labelWithString: o.0)
            label.font = NSFont.titleBarFont(ofSize: 13)
            label.textColor = .secondaryLabelColor
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow - 1, for: .horizontal)
            label.toolTip = o.1
            label.onClick = { [weak self] in self?.onSwitch?(i) }
            stack.addArrangedSubview(label)
            let close = ClickLabel(labelWithString: "×")
            close.font = NSFont.titleBarFont(ofSize: 12)
            close.textColor = .tertiaryLabelColor
            close.toolTip = "Close"
            close.setAccessibilityLabel("Close \(o.0)")
            close.onClick = { [weak self] in self?.onClose?(i) }
            stack.addArrangedSubview(close)
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
