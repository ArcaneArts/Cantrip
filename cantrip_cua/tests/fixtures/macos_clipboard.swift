import AppKit
import Foundation

final class SelectionEditor: NSTextView {
    var hideDirectSelection = false
    var selectionArrayOnly = false
    var attributedSelectionOnly = false
    var rangeAndValueOnly = false
    var moveSelectionOnValueRead = false
    var moveSelectionOnRangeRead = false
    var hideValue = false
    var secure = false

    override func accessibilitySelectedText() -> String? {
        hideDirectSelection || rangeAndValueOnly ? nil : super.accessibilitySelectedText()
    }

    override func accessibilitySelectedTextRange() -> NSRange {
        selectionArrayOnly ? NSRange(location: NSNotFound, length: 0) : super.accessibilitySelectedTextRange()
    }

    override func accessibilitySelectedTextRanges() -> [NSValue]? {
        selectionArrayOnly ? selectedRanges : super.accessibilitySelectedTextRanges()
    }

    override func accessibilityString(for range: NSRange) -> String? {
        if attributedSelectionOnly || rangeAndValueOnly { return nil }
        let value = super.accessibilityString(for: range)
        if moveSelectionOnRangeRead {
            moveSelectionOnRangeRead = false
            setSelectedRange(NSRange(location: 0, length: 3))
        }
        return value
    }

    override func accessibilityAttributedString(for range: NSRange) -> NSAttributedString? {
        rangeAndValueOnly ? nil : super.accessibilityAttributedString(for: range)
    }

    override func accessibilityValue() -> String? {
        if hideValue { return nil }
        let value = super.accessibilityValue()
        if moveSelectionOnValueRead {
            moveSelectionOnValueRead = false
            setSelectedRange(NSRange(location: 0, length: 3))
        }
        return value
    }

    override func accessibilitySubrole() -> NSAccessibility.Subrole? {
        secure ? .secureTextField : super.accessibilitySubrole()
    }
}

final class ClipboardOnlyView: NSView {
    // Let the real Copy action run without replacing the host clipboard.
    let pasteboard = NSPasteboard.withUniqueName()
    static let contents = "custom copy λ🚋"

    @objc func copy(_ sender: Any?) {
        pasteboard.clearContents()
        precondition(pasteboard.setString(Self.contents, forType: .string))
    }
}

final class ClipboardFixtureApp: NSApplication {
    var editor: NSView?

    override var accessibilityFocusedUIElement: Any? {
        editor
    }
}

@main
struct ClipboardFixture {
    static let selection = "selected λ🚋\n\t"
    static let secondSelection = "β \t"

    @MainActor
    static func main() {
        let app = ClipboardFixtureApp.shared as! ClipboardFixtureApp
        let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let clipboard = NSPasteboard.general.changeCount
        app.setActivationPolicy(.prohibited)
        app.finishLaunching()

        func makeWindow(title: String) -> (NSWindow, SelectionEditor) {
            let screen = NSScreen.main!.visibleFrame
            let rect = NSRect(x: screen.minX + 8, y: screen.minY + 8, width: 180, height: 100)
            let window = NSPanel(
                contentRect: rect,
                styleMask: [.titled, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            window.title = title
            let editor = SelectionEditor(frame: NSRect(origin: .zero, size: rect.size))
            editor.string = "outside " + selection + "unselected gap " + secondSelection + "outside"
            editor.setAccessibilityElement(true)
            let content = NSView(frame: NSRect(origin: .zero, size: rect.size))
            content.addSubview(editor)
            window.contentView = content
            window.initialFirstResponder = editor
            precondition(window.makeFirstResponder(editor))
            editor.setSelectedRange((editor.string as NSString).range(of: selection))
            window.orderBack(nil)
            return (window, editor)
        }
        let (selected, editor) = makeWindow(title: "Cantrip selection fixture")
        let (sibling, otherEditor) = makeWindow(title: "Cantrip selection sibling")
        app.editor = editor
        let customCopy = ClipboardOnlyView(frame: .zero)
        customCopy.setAccessibilityElement(true)
        customCopy.setAccessibilityRole(.group)
        var customClipboard = customCopy.pasteboard.changeCount

        func receipt() -> [String: Any] {
            [
                "window": selected.windowNumber,
                "sibling": sibling.windowNumber,
                "foregroundUnchanged": foreground == NSWorkspace.shared.frontmostApplication?.processIdentifier,
                "clipboardUnchanged": clipboard == NSPasteboard.general.changeCount,
                "customClipboardUnchanged": customClipboard == customCopy.pasteboard.changeCount,
            ]
        }
        func report() {
            let data = try! JSONSerialization.data(withJSONObject: receipt())
            FileHandle.standardOutput.write(data + Data([10]))
        }

        DispatchQueue.main.async { report() }
        DispatchQueue.global().asyncAfter(deadline: .now() + 25) { exit(2) }
        DispatchQueue.global().async {
            while let command = readLine() {
                DispatchQueue.main.async {
                    switch command {
                    case "range":
                        editor.hideDirectSelection = true
                    case "attributed":
                        editor.attributedSelectionOnly = true
                    case "range-and-value":
                        editor.rangeAndValueOnly = true
                    case "selection-moves":
                        editor.hideValue = false
                        editor.moveSelectionOnValueRead = true
                    case "range-moves":
                        editor.rangeAndValueOnly = false
                        editor.hideDirectSelection = true
                        editor.attributedSelectionOnly = false
                        editor.setSelectedRange((editor.string as NSString).range(of: selection))
                        editor.moveSelectionOnRangeRead = true
                    case "multiple":
                        editor.hideDirectSelection = false
                        editor.attributedSelectionOnly = false
                        editor.rangeAndValueOnly = false
                        editor.selectedRanges = [selection, secondSelection].map {
                            NSValue(range: (editor.string as NSString).range(of: $0))
                        }
                        let pasteboard = NSPasteboard.withUniqueName()
                        defer { pasteboard.releaseGlobally() }
                        precondition(editor.writeSelection(to: pasteboard, types: editor.writablePasteboardTypes))
                        precondition(pasteboard.string(forType: .string) == selection + secondSelection)
                    case "multiple-parameterized":
                        editor.hideValue = true
                    case "secure":
                        editor.secure = true
                        editor.hideDirectSelection = false
                    case "sibling":
                        editor.secure = false
                        app.editor = otherEditor
                    case "empty":
                        app.editor = editor
                        editor.setSelectedRange(NSRange(location: 0, length: 0))
                    case "one-range-array":
                        editor.hideDirectSelection = true
                        editor.selectionArrayOnly = true
                        editor.setSelectedRange((editor.string as NSString).range(of: selection))
                        let pasteboard = NSPasteboard.withUniqueName()
                        defer { pasteboard.releaseGlobally() }
                        precondition(editor.writeSelection(to: pasteboard, types: editor.writablePasteboardTypes))
                        precondition(pasteboard.string(forType: .string) == selection)
                    case "custom-copy":
                        let content = selected.contentView!
                        customCopy.frame = content.bounds
                        content.addSubview(customCopy)
                        app.editor = customCopy
                        precondition(app.sendAction(#selector(ClipboardOnlyView.copy(_:)), to: customCopy, from: nil))
                        precondition(customCopy.pasteboard.string(forType: .string) == ClipboardOnlyView.contents)
                        customClipboard = customCopy.pasteboard.changeCount
                    case "state":
                        break
                    case "quit":
                        customCopy.pasteboard.releaseGlobally()
                        selected.close()
                        sibling.close()
                        exit(0)
                    default:
                        exit(2)
                    }
                    report()
                }
            }
            DispatchQueue.main.async { exit(0) }
        }
        app.run()
    }
}
