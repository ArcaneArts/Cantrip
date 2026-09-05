import AppKit
import Darwin
import Foundation

// Own-window fixture only: no capture APIs, accessibility APIs, or user input.
// Coordinates in this flipped view deliberately encode PNG top/bottom order.
final class PatternView: NSView {
  override var isFlipped: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1).setFill()
    bounds.fill()
    let w = bounds.width * 0.2
    let h = bounds.height * 0.2
    let patches: [(NSRect, NSColor)] = [
      (NSRect(x: 0, y: 0, width: w, height: h), NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)),
      (NSRect(x: bounds.width-w, y: 0, width: w, height: h), NSColor(srgbRed: 1, green: 1, blue: 0, alpha: 1)),
      (NSRect(x: 0, y: bounds.height-h, width: w, height: h), NSColor(srgbRed: 0, green: 1, blue: 1, alpha: 1)),
      (NSRect(x: bounds.width-w, y: bounds.height-h, width: w, height: h), NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)),
    ]
    for (rect, color) in patches { color.setFill(); rect.fill() }
  }
}

@MainActor
final class NativeFixture {
  private var target: NSWindow?
  private let cover: NSWindow
  private var frame: NSRect
  private var state = "foreground"
  private var lastRequest = 0

  init() {
    let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
    frame = NSRect(x: visible.minX + 80, y: visible.minY + 80, width: 320, height: 240)
    cover = Self.window(frame: frame)
    cover.backgroundColor = NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
    cover.title = "Cantrip CUA fixture occluder"
    createTarget()
    report(requestId: 0)
  }

  private static func window(frame: NSRect) -> NSWindow {
    let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.hasShadow = false
    window.isOpaque = true
    window.sharingType = .readOnly
    return window
  }

  private func createTarget() {
    target = Self.window(frame: frame)
    target?.title = "Cantrip CUA fixture target"
    target?.contentView = PatternView(frame: NSRect(origin: .zero, size: frame.size))
    state = "foreground"
    arrange()
  }

  private func arrange() {
    guard let target else { cover.orderOut(nil); return }
    target.setFrame(frame, display: true)
    target.contentView?.needsDisplay = true
    target.orderFrontRegardless()
    if state == "foreground" {
      cover.orderOut(nil)
    } else {
      let coverFrame = state == "partial"
        ? NSRect(x: frame.midX, y: frame.minY, width: frame.width / 2, height: frame.height)
        : frame
      cover.setFrame(coverFrame, display: true)
      cover.orderFrontRegardless()
      cover.displayIfNeeded()
    }
    target.displayIfNeeded()
  }

  private func report(requestId: Int) {
    // Only fixture-owned window IDs and geometry cross this local pipe.
    let ordered = NSApplication.shared.orderedWindows.map { $0.windowNumber }
    let targetOrder = target.flatMap { ordered.firstIndex(of: $0.windowNumber) }
    let coverOrder = ordered.firstIndex(of: cover.windowNumber)
    let occluded = state != "foreground" && targetOrder != nil && coverOrder != nil && coverOrder! < targetOrder!
    let actualFrame = target?.frame ?? frame
    // AppKit's primary-screen origin is bottom-left; CGWindow/SCWindow use
    // primary-screen top-left. Report only this fixture window's CG geometry.
    let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
    let body: [String: Any] = [
      "version": 1, "requestId": requestId, "status": "ok", "state": state,
      "windowId": target.map { $0.windowNumber as Any } ?? NSNull(),
      "coverWindowId": cover.windowNumber, "processId": ProcessInfo.processInfo.processIdentifier,
      "x": actualFrame.minX, "y": primaryTop - actualFrame.maxY,
      "width": actualFrame.width, "height": actualFrame.height, "occluded": occluded,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { finish(code: 2); return }
    FileHandle.standardOutput.write(data + Data([10]))
  }

  func handle(_ data: Data) {
    guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == Set(["requestId", "command"]),
      let requestId = value["requestId"] as? Int, requestId > lastRequest, requestId <= 64,
      let command = value["command"] as? String else { finish(code: 2); return }
    lastRequest = requestId
    switch command {
    case "foreground", "partial", "full":
      guard target != nil else { finish(code: 2); return }
      state = command; arrange()
    case "move":
      guard target != nil else { finish(code: 2); return }
      frame.origin.x += 28; frame.origin.y += 24; arrange()
    case "resize":
      guard target != nil else { finish(code: 2); return }
      frame.size = NSSize(width: 384, height: 288); arrange()
    case "close":
      target?.close(); target = nil; cover.orderOut(nil); state = "closed"
    case "recreate":
      target?.close(); createTarget()
    case "state": break
    case "quit": finish(code: 0); return
    default: finish(code: 2); return
    }
    report(requestId: requestId)
  }

  func finish(code: Int32) {
    target?.close(); cover.close()
    exit(code)
  }
}

@main
struct FixtureMain {
  @MainActor static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    let fixture = NativeFixture()
    // Independent watchdog still ends a blocked AppKit main loop.
    DispatchQueue.global().asyncAfter(deadline: .now() + 20) { exit(2) }
    DispatchQueue.global().async {
      var buffer = Data()
      var bytes = [UInt8](repeating: 0, count: 4096)
      while true {
        // Foundation's read(upToCount:) can wait to fill its requested count
        // on a pipe. POSIX read returns each available short fragment, so a
        // complete command is handled without waiting for padding or EOF.
        let count = bytes.withUnsafeMutableBytes {
          Darwin.read(STDIN_FILENO, $0.baseAddress!, $0.count)
        }
        if count < 0 && errno == EINTR { continue }
        if count <= 0 {
          let code: Int32 = count == 0 ? 0 : 2
          DispatchQueue.main.async { fixture.finish(code: code) }; return
        }
        buffer.append(contentsOf: bytes.prefix(count))
        if buffer.count > 8192 {
          DispatchQueue.main.async { fixture.finish(code: 2) }; return
        }
        while let newline = buffer.firstIndex(of: 10) {
          let command = buffer[..<newline]
          buffer.removeSubrange(...newline)
          let data = Data(command)
          DispatchQueue.main.async { fixture.handle(data) }
        }
      }
    }
    app.run()
  }
}
