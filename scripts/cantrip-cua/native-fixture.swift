import AppKit
import CoreGraphics
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
  private var retiredWindowId: Int?

  init() {
    let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
    frame = NSRect(x: visible.minX + 80, y: visible.minY + 80, width: 320, height: 240)
    cover = Self.window(frame: frame)
    cover.backgroundColor = NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
    cover.title = "Cantrip CUA fixture occluder"
    createTarget()
    reportWhenCommitted(requestId: 0)
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

  private func windowServerFrame(_ windowId: Int) -> CGRect? {
    // Query only the fixture-owned ID. A failed query must not count as a
    // disappeared window, and unrelated desktop metadata never crosses IPC.
    guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(windowId)) as? [[String: Any]] else {
      finish(code: 2); return nil
    }
    guard let row = rows.first(where: { ($0[kCGWindowNumber as String] as? Int) == windowId }) else { return nil }
    guard (row[kCGWindowOwnerPID as String] as? Int) == Int(ProcessInfo.processInfo.processIdentifier),
      let bounds = row[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else {
      finish(code: 2); return nil
    }
    return rect
  }

  private func cgFrame(_ window: NSWindow) -> CGRect {
    let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
    let rect = window.frame
    return CGRect(x: rect.minX, y: primaryTop - rect.maxY, width: rect.width, height: rect.height)
  }

  private func reportWhenCommitted(requestId: Int, deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 2) {
    // AppKit acknowledges frame/close commands before WindowServer commits
    // them. Observe the actual owned OS window until the command is complete;
    // never relax the subsequent native geometry or closed-target assertions.
    let observed = target.flatMap { windowServerFrame($0.windowNumber) }
    let targetReady = target.map { observed == cgFrame($0) } ?? true
    let retiredReady = retiredWindowId.map { windowServerFrame($0) == nil } ?? true
    let coverReady = state == "foreground" || state == "closed" || windowServerFrame(cover.windowNumber) == cgFrame(cover)
    if targetReady && retiredReady && coverReady {
      report(requestId: requestId, observed: observed)
      return
    }
    guard ProcessInfo.processInfo.systemUptime < deadline else { finish(code: 2); return }
    // Polling yields to AppKit and its autorelease pool between observations.
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(10)) {
      self.reportWhenCommitted(requestId: requestId, deadline: deadline)
    }
  }

  private func report(requestId: Int, observed: CGRect?) {
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
      "windowServerBounds": observed.map { ["x": $0.minX, "y": $0.minY, "width": $0.width, "height": $0.height] as Any } ?? NSNull(),
      "retiredWindowId": retiredWindowId.map { $0 as Any } ?? NSNull(),
      "retiredWindowPresent": retiredWindowId.map { windowServerFrame($0) != nil } ?? false,
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
      retiredWindowId = target?.windowNumber
      target?.close(); target = nil; cover.orderOut(nil); state = "closed"
    case "recreate":
      retiredWindowId = target?.windowNumber ?? retiredWindowId
      target?.close(); createTarget()
    case "state": break
    case "quit": finish(code: 0); return
    default: finish(code: 2); return
    }
    reportWhenCommitted(requestId: requestId)
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
    // Initialization runs before AppKit's event-loop autorelease pools exist.
    // Drain temporary orderedWindows arrays so they cannot retain a closed
    // target for the entire fixture process lifetime.
    let fixture = autoreleasepool { NativeFixture() }
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
