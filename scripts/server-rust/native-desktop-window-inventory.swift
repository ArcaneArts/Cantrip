// Only the acceptance supervisor's exact application PID is observed.
import Cocoa
import CoreGraphics

let pid = Int(CommandLine.arguments[1])!
let all = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] ?? []
let windows = all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid }.map { info in
    [
        "id": info[kCGWindowNumber as String] ?? 0,
        "title": info[kCGWindowName as String] ?? "",
        "bounds": info[kCGWindowBounds as String] ?? [:],
    ]
}
let data = try JSONSerialization.data(withJSONObject: windows, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
