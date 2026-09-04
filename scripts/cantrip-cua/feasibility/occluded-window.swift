import AppKit
import ScreenCaptureKit

// Capture only fixture-owned content: no screenshots of user applications.
@main
struct OccludedWindowProbe {
  @MainActor static func main() async {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    application.finishLaunching()
    let frame = NSRect(x: 140, y: 140, width: 256, height: 192)
    let target = NSWindow(
      contentRect: frame, styleMask: .borderless,
      backing: .buffered, defer: false)
    let cover = NSWindow(
      contentRect: frame, styleMask: .borderless,
      backing: .buffered, defer: false)
    target.title = "Cantrip CUA red capture fixture"
    target.backgroundColor = .red
    cover.title = "Cantrip CUA blue occluder"
    cover.backgroundColor = .blue
    target.isReleasedWhenClosed = false
    cover.isReleasedWhenClosed = false
    target.orderFrontRegardless()
    cover.orderFrontRegardless()
    target.displayIfNeeded()
    cover.displayIfNeeded()

    // An independent deadline also bounds a blocked main executor.
    DispatchQueue.global().asyncAfter(deadline: .now() + 20) {
      fputs(
        "QA_EVT {\"event\":\"occluded-capture\",\"status\":\"fail\",\"reason\":\"native-capture-timeout\"}\n",
        stderr)
      exit(1)
    }
    defer {
      target.close()
      cover.close()
    }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: false)
      guard
        let source = content.windows.first(where: {
          $0.windowID == CGWindowID(target.windowNumber)
        }),
        let occluder = content.windows.first(where: {
          $0.windowID == CGWindowID(cover.windowNumber)
        })
      else { throw ProbeError.fixtureMissing }
      let order =
        (CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
        as? [[String: Any]] ?? []).compactMap { $0[kCGWindowNumber as String] as? UInt32 }
      guard let targetOrder = order.firstIndex(of: source.windowID),
        let coverOrder = order.firstIndex(of: occluder.windowID),
        coverOrder < targetOrder
      else { throw ProbeError.notOccluded }
      let filter = SCContentFilter(desktopIndependentWindow: source)
      let configuration = SCStreamConfiguration()
      configuration.width = 256
      configuration.height = 192
      configuration.showsCursor = false
      let started = ContinuousClock.now
      let image = try await SCScreenshotManager.captureImage(
        contentFilter: filter, configuration: configuration)
      let bitmap = NSBitmapImageRep(cgImage: image)
      guard
        let color = bitmap.colorAt(x: image.width / 2, y: image.height / 2)?
          .usingColorSpace(.deviceRGB),
        color.redComponent > 0.8, color.blueComponent < 0.2,
        color.greenComponent < 0.2
      else { throw ProbeError.wrongPixels }
      print(
        "QA_EVT {\"event\":\"occluded-capture\",\"status\":\"pass\",\"occluded\":true,\"targetColor\":\"red\",\"width\":\(image.width),\"height\":\(image.height),\"captureDuration\":\"\(started.duration(to: .now))\"}"
      )
    } catch {
      let native = error as NSError
      // The native code/domain are sufficient; do not print window titles.
      fputs(
        "QA_EVT {\"event\":\"occluded-capture\",\"status\":\"fail\",\"domain\":\"\(native.domain)\",\"code\":\(native.code)}\n",
        stderr)
      exit(1)
    }
  }

  enum ProbeError: Error { case fixtureMissing, notOccluded, wrongPixels }
}
