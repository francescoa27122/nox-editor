import CoreGraphics
import Foundation

// List on-screen windows and print the id + bounds of the first one owned by
// the app named on the command line. Needs no accessibility permission.
let target = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Nox"
guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}
for window in windows {
    guard let owner = window[kCGWindowOwnerName as String] as? String, owner == target,
          let number = window[kCGWindowNumber as String] as? Int,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? Double, width > 200 else { continue }
    print(number)
    exit(0)
}
exit(2)
