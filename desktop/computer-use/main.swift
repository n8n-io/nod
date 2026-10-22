import AppKit
import ApplicationServices
import Carbon
import ScreenCaptureKit

struct Failure: Error { let message: String }

struct ElementState {
  let element: AXUIElement
  let fingerprint: String
  let window: AXUIElement?
  let windowFingerprint: String?
}

struct Target {
  let state: ElementState
  let focused: Bool
  let label: String
}

var refs: [String: ElementState] = [:]
var targets: [String: Target] = [:]
var observedApp: NSRunningApplication?
var observedFocus: ElementState?

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

func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attr(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func fingerprint(_ element: AXUIElement) throws -> String {
  guard attr(element, kAXRoleAttribute) != nil else {
    throw Failure(message: "The app changed. Look again before acting.")
  }
  let names = [kAXRoleAttribute, kAXSubroleAttribute, kAXIdentifierAttribute, kAXTitleAttribute,
    kAXDescriptionAttribute, "AXLabel", kAXHelpAttribute, kAXValueAttribute, kAXEnabledAttribute,
    kAXURLAttribute, kAXDocumentAttribute]
  let values = names.map { name -> String in
    guard let value = attr(element, name) else { return "" }
    return (value as? String) ?? (value as? NSNumber)?.stringValue ?? ""
  }
  return String(data: try JSONSerialization.data(withJSONObject: values), encoding: .utf8)!
}

func owned(_ element: AXUIElement, _ root: AXUIElement) throws {
  var expected: pid_t = 0
  var actual: pid_t = 0
  guard AXUIElementGetPid(root, &expected) == .success,
    AXUIElementGetPid(element, &actual) == .success, actual == expected else {
    throw Failure(message: "The control does not belong to this app. Look again before acting.")
  }
}

func state(_ element: AXUIElement, _ root: AXUIElement) throws -> ElementState {
  try owned(element, root)
  let window = axElement(element, kAXWindowAttribute) ?? axElement(root, kAXFocusedWindowAttribute)
  if let window { try owned(window, root) }
  return ElementState(element: element, fingerprint: try fingerprint(element), window: window,
    windowFingerprint: try window.map { try fingerprint($0) })
}

func matches(_ saved: ElementState, _ current: ElementState) -> Bool {
  let sameWindow: Bool
  if let before = saved.window, let after = current.window { sameWindow = CFEqual(before, after) }
  else { sameWindow = saved.window == nil && current.window == nil }
  return CFEqual(saved.element, current.element) && saved.fingerprint == current.fingerprint
    && sameWindow && saved.windowFingerprint == current.windowFingerprint
}

func description(_ element: AXUIElement) -> String {
  let role = (text(element, kAXRoleAttribute) ?? "unknown").replacingOccurrences(of: "AX", with: "")
  let label = [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXHelpAttribute]
    .lazy.compactMap { text(element, $0) }.first
  let value = text(element, kAXSubroleAttribute) == "AXSecureTextField" ? nil : text(element, kAXValueAttribute)
  var actions: CFArray?
  AXUIElementCopyActionNames(element, &actions)
  let actionable = ((actions as? [String]) ?? []).filter { $0 != "AXShowDefaultUI" && !$0.contains("\n") }
  var line = role
  if let label { line += " \"\(label.prefix(1000))\"" }
  if let value { line += " value=\"\(value.prefix(200))\"" }
  if !actionable.isEmpty {
    line += " actions=\(actionable.map { $0.replacingOccurrences(of: "AX", with: "") }.joined(separator: ","))"
  }
  return line
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
  targets = [:]
  observedApp = running
  observedFocus = try? state(focused(root), root)
  var lines: [String] = []
  var count = 0
  var visited = 0
  var truncated = false
  func walk(_ element: AXUIElement, _ depth: Int) {
    guard count < 2000, visited < 4000, depth < 40 else { truncated = true; return }
    visited += 1
    guard let saved = try? state(element, root) else { return }
    let line = description(element)
    let role = (text(element, kAXRoleAttribute) ?? "unknown").replacingOccurrences(of: "AX", with: "")
    let children = (attr(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    if !["Group", "unknown", "SplitGroup", "ScrollArea", "Layout"].contains(role) {
      count += 1
      let ref = "e\(count)"
      refs[ref] = saved
      lines.append(String(repeating: "  ", count: depth) + "- \(line) [ref=\(ref)]")
    }
    for child in children { walk(child, depth + 1) }
  }
  let windows = (attr(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  for window in windows { walk(window, 0) }
  if let menu = axElement(root, kAXMenuBarAttribute) { walk(menu, 0) }
  return ["app": describe(running), "tree": lines.joined(separator: "\n"), "truncated": truncated]
}

func observed(_ query: String) throws -> NSRunningApplication {
  let running = try app(query)
  guard let previous = observedApp, !previous.isTerminated,
    running.processIdentifier == previous.processIdentifier else {
    throw Failure(message: "Look at \(query) again before acting.")
  }
  return running
}

func focused(_ root: AXUIElement) throws -> AXUIElement {
  guard let element = axElement(root, kAXFocusedUIElementAttribute) ?? axElement(root, kAXFocusedWindowAttribute) else {
    throw Failure(message: "The app has no focused control. Focus a control from a fresh look first.")
  }
  return element
}

func inspect(_ request: [String: Any]) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Failure(message: "accessibility_permission") }
  let running = try observed(request["app"] as? String ?? "")
  let root = AXUIElementCreateApplication(running.processIdentifier)
  let current: ElementState
  let isFocused: Bool
  if let ref = request["ref"] as? String {
    guard let saved = refs[ref] else { throw Failure(message: "Unknown ref \(ref). Look again before acting.") }
    current = try state(saved.element, root)
    guard matches(saved, current) else { throw Failure(message: "The app changed. Look again before acting.") }
    isFocused = false
  } else {
    current = try state(focused(root), root)
    guard let saved = observedFocus, matches(saved, current) else {
      throw Failure(message: "The focused control changed. Look again before acting.")
    }
    isFocused = true
  }
  guard text(current.element, kAXSubroleAttribute) != "AXSecureTextField" else {
    throw Failure(message: "nod cannot read or enter a private value through Mac app control.")
  }
  for (token, target) in targets where target.focused == isFocused && matches(target.state, current) {
    return ["label": target.label, "token": token]
  }
  let token = UUID().uuidString
  var label = description(current.element)
  if let window = current.window { label += " in \(description(window))" }
  targets[token] = Target(state: current, focused: isFocused, label: label)
  return ["label": label, "token": token]
}

func act(_ request: [String: Any]) throws -> [String: Any] {
  guard AXIsProcessTrusted() else { throw Failure(message: "accessibility_permission") }
  let query = request["app"] as? String ?? ""
  let action = request["action"] as? String ?? ""
  let running = try observed(query)
  let root = AXUIElementCreateApplication(running.processIdentifier)
  guard let token = request["targetToken"] as? String, let saved = targets[token],
    saved.focused == ["type", "key"].contains(action) else {
    throw Failure(message: "The app target expired. Look again before acting.")
  }
  let current = try state(saved.focused ? focused(root) : saved.state.element, root)
  guard matches(saved.state, current) else {
    throw Failure(message: "The app changed. Look again before acting.")
  }
  targets = [:]
  refs = [:]
  observedApp = nil
  observedFocus = nil
  switch action {
  case "type", "key":
    try post(running.processIdentifier, request)
  default:
    let target = current.element
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
    if result != .success {
      throw Failure(message: "\(query) did not complete \(action) (AXError \(result.rawValue)). Look again to check its state.")
    }
  }
  return ["done": true]
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "escape": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121, "forwarddelete": 117,
]

func keyCode(_ name: String, _ flags: CGEventFlags, source: TISInputSource? = nil) throws -> CGKeyCode {
  if let code = keyCodes[name] { return code }
  guard name.count == 1,
    let keyboard = source ?? TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
    let pointer = TISGetInputSourceProperty(keyboard, kTISPropertyUnicodeKeyLayoutData) else {
    throw Failure(message: "Cannot resolve \(name) in the current keyboard layout. Use a visible app control instead.")
  }
  let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
  let layout = UnsafeRawPointer(CFDataGetBytePtr(data)!).assumingMemoryBound(to: UCKeyboardLayout.self)
  let modifiers = flags.contains(.maskCommand) ? UInt32(cmdKey >> 8) : 0
  for code in CGKeyCode(0)..<128 {
    var dead: UInt32 = 0
    var length = 0
    var characters = [UniChar](repeating: 0, count: 8)
    let result = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), modifiers,
      UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead,
      characters.count, &length, &characters)
    if result == noErr && String(utf16CodeUnits: characters, count: length).lowercased() == name {
      return code
    }
  }
  throw Failure(message: "Cannot resolve \(name) in the current keyboard layout. Use a visible app control instead.")
}

func post(_ pid: pid_t, _ request: [String: Any]) throws {
  let source = CGEventSource(stateID: .privateState)
  if request["action"] as? String == "type" {
    for character in (request["text"] as? String ?? "") {
      let units = Array(String(character).utf16)
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
          throw Failure(message: "Mac keyboard input is unavailable. Look again to check what completed.")
        }
        units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!) }
        event.postToPid(pid)
      }
      usleep(4000)
    }
    return
  }
  let parts = (request["key"] as? String ?? "").lowercased().split(separator: "+").map(String.init)
  guard let last = parts.last else {
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
  let code = try keyCode(last, flags)
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw Failure(message: "Mac keyboard input is unavailable. Look again to check what completed.")
    }
    event.flags = flags
    event.postToPid(pid)
  }
}

func windowFrame(_ element: AXUIElement) -> CGRect? {
  guard let position = attr(element, kAXPositionAttribute), let size = attr(element, kAXSizeAttribute),
    CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
    AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
  return CGRect(origin: point, size: dimensions)
}

@MainActor
func screenshot(_ query: String) async throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else { throw Failure(message: "screen_permission") }
  let running = try app(query)
  let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
  let windows = content.windows.filter {
    $0.owningApplication?.processID == running.processIdentifier && $0.windowLayer == 0
      && $0.frame.width > 40 && $0.frame.height > 40
  }
  let root = AXUIElementCreateApplication(running.processIdentifier)
  let primary = AXIsProcessTrusted()
    ? axElement(root, kAXMainWindowAttribute) ?? axElement(root, kAXFocusedWindowAttribute) : nil
  let frame = primary.flatMap { element -> CGRect? in
    guard (try? owned(element, root)) != nil else { return nil }
    return windowFrame(element)
  }
  let main = frame.flatMap { frame in windows.first {
    abs($0.frame.minX - frame.minX) < 2 && abs($0.frame.minY - frame.minY) < 2
      && abs($0.frame.width - frame.width) < 2 && abs($0.frame.height - frame.height) < 2
  } }
  let visible = windows.filter { $0.isOnScreen }
  guard let window = main ?? (visible.isEmpty ? windows : visible).max(by: {
    $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
  }) else {
    throw Failure(message: "\(query) has no window to capture.")
  }
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let config = SCStreamConfiguration()
  let scale = min(1, 1600 / max(window.frame.width, 1))
  config.width = Int(window.frame.width * scale * 2) / 2
  config.height = Int(window.frame.height * scale * 2) / 2
  config.showsCursor = false
  let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), !png.isEmpty else {
    throw Failure(message: "The app screenshot could not be encoded.")
  }
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

@MainActor
func open(_ query: String) async throws -> [String: Any] {
  guard let url = appURL(query) else { throw Failure(message: "No app named \(query).") }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = false
  return describe(try await NSWorkspace.shared.openApplication(at: url, configuration: configuration))
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

@MainActor
func handle(_ message: [String: Any]) async throws -> Any {
  let query = message["app"] as? String ?? ""
  switch message["op"] as? String {
  case "status": return status()
  case "request": request(message["permission"] as? String ?? ""); return status()
  case "apps":
    return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(describe)
  case "resolve": return describe(try app(query))
  case "identify": return try identify(query)
  case "open": return try await open(query)
  case "look": return try look(query)
  case "inspect": return try inspect(message)
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

let requests = AsyncStream<String> { continuation in
  DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) { continuation.yield(line) }
    continuation.finish()
  }
}

Task { @MainActor in
  for await line in requests {
    guard let data = line.data(using: .utf8),
      let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    let id = message["id"] ?? NSNull()
    do {
      reply(["id": id, "ok": true, "result": try await handle(message)])
    } catch let failure as Failure {
      reply(["id": id, "ok": false, "error": failure.message])
    } catch {
      let failure = error as NSError
      let message = failure.domain == SCStreamErrorDomain && failure.code == SCStreamError.Code.userDeclined.rawValue
        ? "screen_permission" : failure.localizedDescription
      reply(["id": id, "ok": false, "error": message])
    }
  }
  exit(0)
}
RunLoop.main.run()
