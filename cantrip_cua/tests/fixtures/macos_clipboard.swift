import AppKit
import Foundation

final class SelectionEditor: NSTextView {
    var hideDirectSelection = false
    var attributedSelectionOnly = false
    var secure = false

    override func accessibilitySelectedText() -> String? {
        hideDirectSelection ? nil : super.accessibilitySelectedText()
    }

    override func accessibilityString(for range: NSRange) -> String? {
        attributedSelectionOnly ? nil : super.accessibilityString(for: range)
    }

    override func accessibilitySubrole() -> NSAccessibility.Subrole? {
        secure ? .secureTextField : super.accessibilitySubrole()
    }
}

final class ClipboardFixtureApp: NSApplication {
    var editor: SelectionEditor?

    override var accessibilityFocusedUIElement: Any? {
        editor
    }
}

@main
struct ClipboardFixture {
    static let selection = "selected λ🚋\n\t"

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
            editor.string = "outside " + selection + "outside"
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

        func receipt() -> [String: Any] {
            [
                "window": selected.windowNumber,
                "sibling": sibling.windowNumber,
                "foregroundUnchanged": foreground == NSWorkspace.shared.frontmostApplication?.processIdentifier,
                "clipboardUnchanged": clipboard == NSPasteboard.general.changeCount,
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
                    case "secure":
                        editor.secure = true
                        editor.hideDirectSelection = false
                    case "sibling":
                        editor.secure = false
                        app.editor = otherEditor
                    case "empty":
                        app.editor = editor
                        editor.setSelectedRange(NSRange(location: 0, length: 0))
                    case "state":
                        break
                    case "quit":
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
