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
        stack.spacing = 4
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            heightAnchor.constraint(equalToConstant: 24),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 320),
            widthAnchor.constraint(lessThanOrEqualToConstant: 620),
        ])
        set(["AI UI"])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.06).cgColor
    }

    func set(_ items: [String]) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, title) in items.enumerated() {
            if i > 0 {
                let sep = NSTextField(labelWithString: "›")
                sep.font = .systemFont(ofSize: 12)
                sep.textColor = .tertiaryLabelColor
                stack.addArrangedSubview(sep)
            }
            let b = NSButton(title: title, target: self, action: #selector(clicked(_:)))
            b.tag = i
            b.isBordered = false
            b.font = .systemFont(ofSize: 12, weight: i == items.count - 1 ? .semibold : .regular)
            b.contentTintColor = i == items.count - 1 ? .labelColor : .secondaryLabelColor
            b.lineBreakMode = .byTruncatingTail
            b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            b.toolTip = title
            stack.addArrangedSubview(b)
        }
        needsDisplay = true
    }

    @objc private func clicked(_ sender: NSButton) { onSelect?(sender.tag) }
}
