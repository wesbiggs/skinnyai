// SkinnyAI.app: a thin native shell around the bundled `skinnyai` binary.
// It opens chats in Terminal.app (or iTerm2, if installed) and provides a
// Settings window (Cmd-,) that edits ~/.skinny/.env.

import AppKit
import SwiftUI

// MARK: - Paths

let homeDirectory: URL = {
    if let custom = ProcessInfo.processInfo.environment["SKINNY_HOME"], !custom.isEmpty {
        return URL(fileURLWithPath: custom)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".skinny")
}()
let envFileURL = homeDirectory.appendingPathComponent(".env")
let sessionsURL = homeDirectory.appendingPathComponent("sessions")

// MARK: - .env file
// Edits keep comments, blank lines, and variables this app doesn't know about.
// Parsing and quoting mirror loadEnvFile() in bin/skinnyai.js.

struct EnvFile {
    private(set) var lines: [String]
    private static let assignment = try! NSRegularExpression(pattern: #"^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$"#)

    init(contentsOf url: URL) {
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        var parsed = text.components(separatedBy: CharacterSet.newlines).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\r")) }
        if parsed.last == "" { parsed.removeLast() }
        lines = parsed
    }

    private static func parse(_ line: String) -> (key: String, value: String)? {
        let range = NSRange(line.startIndex..., in: line)
        guard let match = assignment.firstMatch(in: line, range: range),
              let keyRange = Range(match.range(at: 1), in: line),
              let valueRange = Range(match.range(at: 2), in: line) else { return nil }
        var value = String(line[valueRange])
        if value.count >= 2, let first = value.first, first == "\"" || first == "'", value.last == first {
            let inner = String(value.dropFirst().dropLast())
            value = first == "\""
                ? inner.replacingOccurrences(of: "\\n", with: "\n")
                       .replacingOccurrences(of: "\\\"", with: "\"")
                       .replacingOccurrences(of: "\\\\", with: "\\")
                : inner
        } else if let comment = value.range(of: #"\s+#.*$"#, options: .regularExpression) {
            value.removeSubrange(comment)
        }
        return (String(line[keyRange]), value)
    }

    func value(_ key: String) -> String? {
        var found: String?
        for line in lines { if let (k, v) = Self.parse(line), k == key { found = v } } // last one wins, as in the loader
        return found
    }

    private static func encode(_ value: String) -> String {
        if value.range(of: #"^[\w./:@%+,=~#-]*$"#, options: .regularExpression) != nil { return value }
        let escaped = value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "\"\(escaped)\""
    }

    /// Sets `key` (replacing its existing line, or appending), or removes it when `value` is nil or empty.
    mutating func set(_ key: String, _ value: String?) {
        let indexes = lines.indices.filter { Self.parse(lines[$0])?.key == key }
        guard let value, !value.isEmpty else {
            for index in indexes.reversed() { lines.remove(at: index) }
            return
        }
        let line = "\(key)=\(Self.encode(value))"
        if let first = indexes.first {
            lines[first] = line
            for index in indexes.dropFirst().reversed() { lines.remove(at: index) }
        } else {
            lines.append(line)
        }
    }

    func write(to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let text = lines.joined(separator: "\n") + (lines.isEmpty ? "" : "\n")
        try text.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) // it may hold an API key
    }
}

// MARK: - Settings model

struct BoolSetting {
    let key: String
    let title: String
    let detail: String
    let defaultValue: Bool
}

let boolSettings: [BoolSetting] = [
    BoolSetting(key: "SKINNY_TOOLS", title: "Web search and page reading", detail: "Let the model look things up online.", defaultValue: false),
    BoolSetting(key: "SKINNY_AUTOSAVE", title: "Autosave conversations", detail: "Save each chat to ~/.skinny/sessions as you go.", defaultValue: false),
    BoolSetting(key: "SKINNY_MARKDOWN", title: "Format replies (markdown)", detail: "Bold, lists, tables, and code blocks.", defaultValue: true),
    BoolSetting(key: "SKINNY_IMAGES", title: "Show inline images", detail: "Needs iTerm2; fetches image URLs in replies.", defaultValue: false),
    BoolSetting(key: "SKINNY_HIDE_THINKING", title: "Hide the model's thinking", detail: "Show only final answers from reasoning models.", defaultValue: false),
    BoolSetting(key: "SKINNY_STOP_ON_EXIT", title: "Unload the model on exit", detail: "Frees memory for local Ollama models.", defaultValue: false),
]

func parseBool(_ text: String?) -> Bool? {
    guard let text else { return nil }
    switch text.lowercased() {
    case "1", "true", "yes", "on": return true
    case "0", "false", "no", "off": return false
    default: return nil
    }
}

final class SettingsModel: ObservableObject {
    @Published var apiKey = ""
    @Published var host = ""
    @Published var api = "ollama"
    @Published var model = ""
    @Published var keepAlive = ""
    @Published var flags: [String: Bool] = [:]
    @Published var terminal = UserDefaults.standard.string(forKey: "terminal") ?? "auto"
    @Published var message: String?

    private var env = EnvFile(contentsOf: envFileURL)

    init() { load() }

    func load() {
        env = EnvFile(contentsOf: envFileURL)
        apiKey = env.value("OLLAMA_API_KEY") ?? ""
        host = env.value("SKINNY_HOST") ?? ""
        api = env.value("SKINNY_API") == "openai" ? "openai" : "ollama"
        model = env.value("SKINNY_MODEL") ?? ""
        keepAlive = env.value("SKINNY_KEEP_ALIVE") ?? ""
        for setting in boolSettings {
            flags[setting.key] = parseBool(env.value(setting.key)) ?? setting.defaultValue
        }
    }

    var isConfigured: Bool { !(EnvFile(contentsOf: envFileURL).value("SKINNY_MODEL") ?? "").isEmpty }

    /// Returns true when saved.
    func save() -> Bool {
        env = EnvFile(contentsOf: envFileURL) // pick up edits made outside the app
        env.set("OLLAMA_API_KEY", apiKey.trimmingCharacters(in: .whitespaces))
        env.set("SKINNY_HOST", host.trimmingCharacters(in: .whitespaces))
        env.set("SKINNY_API", api == "openai" ? "openai" : nil)
        env.set("SKINNY_MODEL", model.trimmingCharacters(in: .whitespaces))
        env.set("SKINNY_KEEP_ALIVE", keepAlive.trimmingCharacters(in: .whitespaces))
        for setting in boolSettings {
            let value = flags[setting.key] ?? setting.defaultValue
            // Leave variables alone when they already match the default and aren't in the file.
            if value == setting.defaultValue && env.value(setting.key) == nil { continue }
            env.set(setting.key, value ? "true" : "false")
        }
        UserDefaults.standard.set(terminal, forKey: "terminal")
        do {
            try env.write(to: envFileURL)
            message = nil
            return true
        } catch {
            message = "Couldn't save: \(error.localizedDescription)"
            return false
        }
    }
}

// MARK: - Settings view

struct SettingsView: View {
    @ObservedObject var model: SettingsModel
    var onSave: (Bool) -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Connection") {
                    SecureField("Ollama API key", text: $model.apiKey, prompt: Text("needed for ollama.com cloud models and search"))
                    Link("Get a free key at ollama.com/settings/keys", destination: URL(string: "https://ollama.com/settings/keys")!)
                        .font(.caption)
                    TextField("Server", text: $model.host, prompt: Text("http://localhost:11434"))
                    Picker("API", selection: $model.api) {
                        Text("Ollama").tag("ollama")
                        Text("OpenAI-compatible").tag("openai")
                    }
                    TextField("Model", text: $model.model, prompt: Text("e.g. gemma4:31b"))
                    TextField("Keep model loaded", text: $model.keepAlive, prompt: Text("1h"))
                }
                Section("Behavior") {
                    ForEach(boolSettings, id: \.key) { setting in
                        Toggle(isOn: Binding(
                            get: { model.flags[setting.key] ?? setting.defaultValue },
                            set: { model.flags[setting.key] = $0 }
                        )) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(setting.title)
                                Text(setting.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("App") {
                    Picker("Open chats in", selection: $model.terminal) {
                        Text("Automatic (iTerm if installed)").tag("auto")
                        Text("Terminal").tag("terminal")
                        Text("iTerm").tag("iterm")
                    }
                    HStack {
                        Button("Open .env in Editor") { NSWorkspace.shared.open(ensureEnvFile()) }
                        Button("Show Saved Chats") {
                            try? FileManager.default.createDirectory(at: sessionsURL, withIntermediateDirectories: true)
                            NSWorkspace.shared.open(sessionsURL)
                        }
                    }
                }
            }
            .formStyle(.grouped)

            HStack {
                if let message = model.message {
                    Text(message).foregroundStyle(.red).font(.caption)
                } else {
                    Text("Changes apply to chats you start afterwards.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Save") { if model.save() { onSave(false) } }
                Button("Save & Start Chat") { if model.save() { onSave(true) } }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 520, height: 740)
    }
}

func ensureEnvFile() -> URL {
    if !FileManager.default.fileExists(atPath: envFileURL.path) {
        try? EnvFile(contentsOf: envFileURL).write(to: envFileURL)
    }
    return envFileURL
}

// MARK: - Launching chats

func shellQuote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }

func terminalApp(preference: String) -> URL? {
    let workspace = NSWorkspace.shared
    let iterm = workspace.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2")
    let terminal = workspace.urlForApplication(withBundleIdentifier: "com.apple.Terminal")
    switch preference {
    case "terminal": return terminal ?? iterm
    case "iterm": return iterm ?? terminal
    default: return iterm ?? terminal
    }
}

/// Opens a new terminal window running skinnyai. A .command file does this
/// without the Automation permission prompt that scripting the terminal would need.
func startChat() {
    guard let binary = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("skinnyai-cli"),
          FileManager.default.isExecutableFile(atPath: binary.path) else {
        alert("The skinnyai program is missing from this app.")
        return
    }
    guard let app = terminalApp(preference: UserDefaults.standard.string(forKey: "terminal") ?? "auto") else {
        alert("Couldn't find Terminal or iTerm.")
        return
    }
    let script = FileManager.default.temporaryDirectory.appendingPathComponent("skinnyai-\(UUID().uuidString).command")
    var body = "#!/bin/zsh\nrm -f -- \"$0\"\n"
    if let custom = ProcessInfo.processInfo.environment["SKINNY_HOME"], !custom.isEmpty { body += "export SKINNY_HOME=\(shellQuote(custom))\n" }
    body += "exec \(shellQuote(binary.path))\n"
    do {
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
    } catch {
        alert("Couldn't start a chat: \(error.localizedDescription)")
        return
    }
    NSWorkspace.shared.open([script], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
        if let error { DispatchQueue.main.async { alert("Couldn't open \(app.lastPathComponent): \(error.localizedDescription)") } }
    }
}

func alert(_ text: String) {
    let alert = NSAlert()
    alert.messageText = text
    alert.runModal()
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var settingsWindow: NSWindow?
    private let settings = SettingsModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
        if settings.isConfigured { startChat() } else { showSettings() }
    }

    // Clicking the Dock icon again starts another chat.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if settings.isConfigured { startChat() } else { showSettings() }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    @objc func newChat(_ sender: Any?) {
        if settings.isConfigured { startChat() } else { showSettings() }
    }

    @objc func showSettings(_ sender: Any? = nil) {
        settings.load()
        if settingsWindow == nil {
            let view = SettingsView(
                model: settings,
                onSave: { [weak self] start in
                    self?.settingsWindow?.close()
                    if start { startChat() }
                },
                onCancel: { [weak self] in self?.settingsWindow?.close() }
            )
            let window = NSWindow(contentViewController: NSHostingController(rootView: view))
            window.title = "SkinnyAI Settings"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    @objc func showHelp(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/wesbiggs/skinnyai#readme")!)
    }

    private func buildMenu() {
        let name = "SkinnyAI"
        let main = NSMenu()

        func add(_ title: String, _ menu: NSMenu, _ action: Selector?, _ key: String = "", target: AnyObject? = nil) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = target
            menu.addItem(item)
        }
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }

        let app = submenu(name)
        add("About \(name)", app, #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        app.addItem(.separator())
        add("Settings…", app, #selector(showSettings(_:)), ",", target: self)
        app.addItem(.separator())
        add("Hide \(name)", app, #selector(NSApplication.hide(_:)), "h")
        add("Quit \(name)", app, #selector(NSApplication.terminate(_:)), "q")

        let file = submenu("File")
        add("New Chat", file, #selector(newChat(_:)), "n", target: self)

        let edit = submenu("Edit")
        add("Undo", edit, Selector(("undo:")), "z")
        add("Redo", edit, Selector(("redo:")), "Z")
        edit.addItem(.separator())
        add("Cut", edit, #selector(NSText.cut(_:)), "x")
        add("Copy", edit, #selector(NSText.copy(_:)), "c")
        add("Paste", edit, #selector(NSText.paste(_:)), "v")
        add("Select All", edit, #selector(NSText.selectAll(_:)), "a")

        let window = submenu("Window")
        add("Close", window, #selector(NSWindow.performClose(_:)), "w")
        add("Minimize", window, #selector(NSWindow.performMiniaturize(_:)), "m")
        NSApp.windowsMenu = window

        let help = submenu("Help")
        add("\(name) Help", help, #selector(showHelp(_:)), "?", target: self)

        NSApp.mainMenu = main
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
