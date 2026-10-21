import AppKit
import ApplicationServices
import ScreenCaptureKit

struct Failure: Error { let message: String }

var refs: [String: AXUIElement] = [:]
var refApp: pid_t = 0

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func oneLine(_ value: String) -> String {
  return value.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
}

func text(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attr(element, name) else { return nil }
  if let string = value as? String { return string.isEmpty ? nil : oneLine(string) }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func app(_ query: String) throws -> NSRunningApplication {
  let lowered = query.lowercased()
  let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  if let match = running.first(where: {
    $0.bundleIdentifier?.lowercased() == lowered || $0.localizedName?.lowercased() == lowered
  }) {
    return match
  }
  throw Failure(message: "\(query) is not running. Open it first.")
}

func describe(_ running: NSRunningApplication) -> [String: Any] {
  [
    "name": running.localizedName ?? "",
    "bundleId": running.bundleIdentifier ?? "",
    "pid": Int(running.processIdentifier),
    "active": running.isActive,
  ]
}

func look(_ query: String) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Failure(message: "accessibility_permission") }
  let running = try app(query)
  let root = AXUIElementCreateApplication(running.processIdentifier)
  AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  refs = [:]
  refApp = running.processIdentifier
  var lines: [String] = []
  var count = 0
  func walk(_ element: AXUIElement, _ depth: Int) {
    guard count < 2000, depth < 40 else { return }
    let role = (text(element, kAXRoleAttribute) ?? "unknown").replacingOccurrences(of: "AX", with: "")
    let label = [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXHelpAttribute]
      .lazy.compactMap { text(element, $0) }.first
    let value = text(element, kAXValueAttribute).map { String($0.prefix(200)) }
    var actions: CFArray?
    AXUIElementCopyActionNames(element, &actions)
    let actionable = ((actions as? [String]) ?? []).filter { $0 != "AXShowDefaultUI" && !$0.contains("\n") }
    let children = (attr(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    let skip = label == nil && value == nil && actionable.isEmpty && ["Group", "unknown", "SplitGroup", "ScrollArea", "Layout"].contains(role)
    var nextDepth = depth
    if !skip {
      count += 1
      let ref = "e\(count)"
      refs[ref] = element
      var line = String(repeating: "  ", count: depth) + "- \(role)"
      if let label { line += " \"\(label.prefix(120))\"" }
      if let value { line += " value=\"\(value)\"" }
      if !actionable.isEmpty {
        line += " actions=\(actionable.map { $0.replacingOccurrences(of: "AX", with: "") }.joined(separator: ","))"
      }
      line += " [ref=\(ref)]"
      lines.append(line)
      nextDepth += 1
    }
    for child in children { walk(child, nextDepth) }
  }
  let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  for window in windows { walk(window, 0) }
  if let menu = attr(root, kAXMenuBarAttribute) { walk(menu as! AXUIElement, 0) }
  return ["app": describe(running), "tree": lines.joined(separator: "\n"), "truncated": count >= 2000]
}

func element(_ ref: String, _ query: String) throws -> AXUIElement {
  let running = try app(query)
  guard running.processIdentifier == refApp, let found = refs[ref] else {
    throw Failure(message: "Unknown ref \(ref). Look at \(query) again first.")
  }
  return found
}

func act(_ request: [String: Any]) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Failure(message: "accessibility_permission") }
  let query = request["app"] as? String ?? ""
  let action = request["action"] as? String ?? ""
  switch action {
  case "type", "key":
    let running = try app(query)
    try post(running.processIdentifier, request)
  default:
    let target = try element(request["ref"] as? String ?? "", query)
    let result: AXError
    switch action {
    case "set":
      result = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, (request["value"] as? String ?? "") as CFString)
    case "focus":
      result = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    default:
      let name = "AX" + action.prefix(1).uppercased() + action.dropFirst()
      result = AXUIElementPerformAction(target, name as CFString)
    }
    if result != .success && result != .cannotComplete {
      throw Failure(message: "\(query) refused \(action) (AXError \(result.rawValue)).")
    }
  }
  return ["done": true]
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "escape": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121, "forwarddelete": 117,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35,
  "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]

func post(_ pid: pid_t, _ request: [String: Any]) throws {
  let source = CGEventSource(stateID: .privateState)
  if request["action"] as? String == "type" {
    for scalar in (request["text"] as? String ?? "").utf16 {
      var unit = scalar
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
        event.keyboardSetUnicodeString(stringLength: 1, unicodeString: &unit)
        event.postToPid(pid)
      }
      usleep(4000)
    }
    return
  }
  let parts = (request["key"] as? String ?? "").lowercased().split(separator: "+").map(String.init)
  guard let last = parts.last, let code = keyCodes[last] else {
    throw Failure(message: "Unknown key \(request["key"] ?? "").")
  }
  var flags: CGEventFlags = []
  for modifier in parts.dropLast() {
    switch modifier {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: throw Failure(message: "Unknown modifier \(modifier).")
    }
  }
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
    event.flags = flags
    event.postToPid(pid)
  }
}

func screenshot(_ query: String) async throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else { throw Failure(message: "screen_permission") }
  let running = try app(query)
  let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
  let windows = content.windows.filter {
    $0.owningApplication?.processID == running.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 40
  }
  guard let window = windows.first(where: { $0.isOnScreen }) ?? windows.first else {
    throw Failure(message: "\(query) has no window to capture.")
  }
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let config = SCStreamConfiguration()
  let scale = min(1, 1600 / max(window.frame.width, 1))
  config.width = Int(window.frame.width * scale * 2) / 2
  config.height = Int(window.frame.height * scale * 2) / 2
  config.showsCursor = false
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) ?? Data()
  return ["app": describe(running), "title": window.title ?? "", "png": png.base64EncodedString()]
}

func appURL(_ query: String) -> URL? {
  if query.contains("/") { return nil }
  return NSWorkspace.shared.urlForApplication(withBundleIdentifier: query)
    ?? ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
      .map { URL(fileURLWithPath: "\($0)/\(query).app") }
      .first { FileManager.default.fileExists(atPath: $0.path) }
}

func identify(_ query: String) throws -> [String: Any] {
  guard let url = appURL(query) else { throw Failure(message: "No app named \(query).") }
  let bundle = Bundle(url: url)
  return ["name": url.deletingPathExtension().lastPathComponent, "bundleId": bundle?.bundleIdentifier ?? ""]
}

func open(_ query: String) throws -> [String: Any] {
  guard let url = appURL(query) else { throw Failure(message: "No app named \(query).") }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = false
  let semaphore = DispatchSemaphore(value: 0)
  var failure: Error?
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
    failure = error
    semaphore.signal()
  }
  semaphore.wait()
  if let failure { throw Failure(message: failure.localizedDescription) }
  let bundle = Bundle(url: url)
  return ["name": url.deletingPathExtension().lastPathComponent, "bundleId": bundle?.bundleIdentifier ?? ""]
}

func status() -> [String: Any] {
  ["accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()]
}

func request(_ kind: String) {
  if kind == "accessibility" {
    AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
  } else {
    CGRequestScreenCaptureAccess()
  }
}

func handle(_ message: [String: Any]) async throws -> Any {
  let query = message["app"] as? String ?? ""
  switch message["op"] as? String {
  case "status": return status()
  case "request": request(message["permission"] as? String ?? ""); return status()
  case "apps":
    return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(describe)
  case "resolve": return describe(try app(query))
  case "identify": return try identify(query)
  case "open": return try open(query)
  case "look": return try look(query)
  case "act": return try act(message)
  case "screenshot": return try await screenshot(query)
  default: throw Failure(message: "Unknown op.")
  }
}

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}

NSApplication.shared.setActivationPolicy(.prohibited)

Task {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
      let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    let id = message["id"] ?? NSNull()
    do {
      reply(["id": id, "ok": true, "result": try await handle(message)])
    } catch let failure as Failure {
      reply(["id": id, "ok": false, "error": failure.message])
    } catch {
      reply(["id": id, "ok": false, "error": error.localizedDescription])
    }
  }
  exit(0)
}
RunLoop.main.run()
