// SkinnyAI.app: a thin native shell around the bundled `skinnyai` binary.
// It runs chats in its own terminal windows (SwiftTerm), or in Terminal.app /
// iTerm2 if preferred, and provides a Settings window (Cmd-,) that edits
// ~/.skinny/.env.

import AppKit
import SwiftTerm
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
/// The running chat's process id, written by the launcher script (which then execs the chat, keeping the pid).
let chatPidURL = homeDirectory.appendingPathComponent("app-chat.pid")

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
    /// What the app offers (and shows) when the variable isn't in .env yet.
    let defaultValue: Bool
    /// Only meaningful for a self-hosted Ollama, which loads and unloads models itself.
    var localOllamaOnly = false
}

let boolSettings: [BoolSetting] = [
    BoolSetting(key: "SKINNY_TOOLS", title: "Web search and page reading", detail: "Let the model look things up online.", defaultValue: true),
    BoolSetting(key: "SKINNY_AUTOSAVE", title: "Autosave conversations", detail: "Save each chat to ~/.skinny/sessions as you go.", defaultValue: false),
    BoolSetting(key: "SKINNY_MARKDOWN", title: "Format replies (markdown)", detail: "Bold, lists, tables, and code blocks.", defaultValue: true),
    BoolSetting(key: "SKINNY_IMAGES", title: "Show inline images", detail: "Needs iTerm2; fetches image URLs in replies.", defaultValue: false),
    BoolSetting(key: "SKINNY_HIDE_THINKING", title: "Hide the model's thinking", detail: "Show only final answers from reasoning models.", defaultValue: false),
    BoolSetting(key: "SKINNY_DEBUG", title: "Debug log", detail: "Record requests, offered tools, and tool calls in ~/.skinny/debug.log.", defaultValue: false),
    BoolSetting(key: "SKINNY_STOP_ON_EXIT", title: "Unload the model on exit", detail: "Frees memory for local Ollama models.", defaultValue: false, localOllamaOnly: true),
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
    @Published var anthropicKey = ""
    @Published var host = ""
    /// ollama-local, ollama-cloud, openai-cloud, openai-other, or anthropic.
    @Published var provider = "ollama-local" {
        didSet {
            // Picking another provider fills in its usual address, since one provider's URL is wrong for
            // another (not while loading saved settings), and its model names don't carry over either.
            guard !loading, provider != oldValue else { return }
            host = SettingsModel.suggestedHost(for: provider)
            model = SettingsModel.supportsDefaultModel(provider) ? "default" : ""
            typeModelName = false
        }
    }
    @Published var openaiKey = ""

    /// The skinnyai program's API (SKINNY_API) behind the provider.
    var api: String {
        if provider.hasPrefix("ollama") { return "ollama" }
        return provider.hasPrefix("openai") ? "openai" : "anthropic"
    }
    @Published var model = ""
    @Published var keepAlive = ""
    @Published var flags: [String: Bool] = [:]
    @Published var fontSize = Double(currentFontSize())
    @Published var terminal = UserDefaults.standard.string(forKey: "chatIn") ?? "builtin"
    @Published var message: String?
    @Published var availableModels: [String] = []
    @Published var modelsStatus: String?
    @Published var loadingModels = false
    @Published var typeModelName = false
    private var modelsRequest = 0
    private var loading = false

    /// The address offered when a provider is picked. (Other OpenAI-compatible servers vary — LM Studio
    /// is :1234, vLLM :8000 — but Ollama also serves that API on its own port, so that's the starting point.)
    static func suggestedHost(for provider: String) -> String {
        switch provider {
        case "ollama-cloud": return "https://ollama.com"
        case "openai-cloud": return "https://api.openai.com"
        case "anthropic": return "https://api.anthropic.com"
        default: return "http://localhost:11434"
        }
    }

    /// What the skinnyai program connects to when SKINNY_HOST isn't set.
    static func programHost(for api: String) -> String {
        api == "anthropic" ? "https://api.anthropic.com" : "http://localhost:11434"
    }

    /// OpenAI and Anthropic have no flagship alias, so "default" tells skinnyai to look up the newest
    /// flagship from the server's model list each time it starts.
    static func supportsDefaultModel(_ provider: String) -> Bool { provider == "openai-cloud" || provider == "anthropic" }

    static func hostName(_ text: String) -> String {
        URL(string: text.contains("://") ? text : "http://" + text)?.host?.lowercased() ?? ""
    }

    /// Which provider a saved API and server amount to.
    static func provider(api: String, host: String) -> String {
        let name = hostName(host)
        switch api {
        case "anthropic": return "anthropic"
        case "openai": return name == "api.openai.com" ? "openai-cloud" : "openai-other"
        default: return name == "ollama.com" || name.hasSuffix(".ollama.com") ? "ollama-cloud" : "ollama-local"
        }
    }

    private var env = EnvFile(contentsOf: envFileURL)

    init() { load() }

    func load() {
        loading = true
        defer { loading = false }
        fontSize = Double(currentFontSize())
        env = EnvFile(contentsOf: envFileURL)
        apiKey = env.value("OLLAMA_API_KEY") ?? ""
        anthropicKey = env.value("ANTHROPIC_API_KEY") ?? ""
        openaiKey = env.value("OPENAI_API_KEY") ?? ""
        let savedAPI = env.value("SKINNY_API") ?? ""
        let savedHost = env.value("SKINNY_HOST")
        let savedProgramAPI = ["openai", "anthropic"].contains(savedAPI) ? savedAPI : "ollama"
        let effectiveHost = savedHost ?? SettingsModel.programHost(for: savedProgramAPI)
        provider = SettingsModel.provider(api: savedProgramAPI, host: effectiveHost)
        host = effectiveHost
        model = env.value("SKINNY_MODEL") ?? ""
        keepAlive = env.value("SKINNY_KEEP_ALIVE") ?? ""
        for setting in boolSettings {
            flags[setting.key] = parseBool(env.value(setting.key)) ?? setting.defaultValue
        }
        refreshModels()
    }

    // MARK: Model list

    var serverURL: URL? {
        let typed = host.trimmingCharacters(in: .whitespaces)
        var text = typed.isEmpty ? SettingsModel.suggestedHost(for: provider) : typed
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        return URL(string: text)
    }

    var isOllamaCom: Bool {
        let name = serverURL?.host?.lowercased() ?? ""
        return name == "ollama.com" || name.hasSuffix(".ollama.com")
    }

    /// keep-alive and unloading only apply to a self-hosted Ollama.
    var managesModelLifetime: Bool { api == "ollama" && !isOllamaCom }

    private var refreshWork: DispatchWorkItem?

    /// Asks the server for its models a moment after the last edit to the server or key.
    func scheduleRefresh() {
        refreshWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.refreshModels() }
        refreshWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
    }

    func refreshModels() {
        refreshWork?.cancel()
        modelsRequest += 1
        let request = modelsRequest
        guard let base = serverURL else {
            availableModels = []
            modelsStatus = "That server address doesn't look right."
            return
        }
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        let basePath = components.path
        components.path = basePath + (api == "ollama" ? "/api/tags" : "/v1/models")
        if api == "anthropic" { components.queryItems = [URLQueryItem(name: "limit", value: "100")] }
        guard let url = components.url else { return }
        var urlRequest = URLRequest(url: url, timeoutInterval: 6)
        let ollamaKey = apiKey.trimmingCharacters(in: .whitespaces)
        let claudeKey = anthropicKey.trimmingCharacters(in: .whitespaces)
        let openaiToken = openaiKey.trimmingCharacters(in: .whitespaces)
        if api == "openai" && !openaiToken.isEmpty {
            urlRequest.setValue("Bearer \(openaiToken)", forHTTPHeaderField: "Authorization")
        } else if api == "anthropic" {
            urlRequest.setValue(claudeKey, forHTTPHeaderField: "x-api-key")
            urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        } else if api == "ollama" && isOllamaCom && url.scheme == "https" && !ollamaKey.isEmpty {
            urlRequest.setValue("Bearer \(ollamaKey)", forHTTPHeaderField: "Authorization")
        }
        let isOllama = api == "ollama"
        loadingModels = true
        modelsStatus = nil
        URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            var names: [String] = []
            var failure: String?
            if let error {
                failure = error.localizedDescription
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                failure = http.statusCode == 401 || http.statusCode == 403 ? "the server rejected the API key" : "the server answered HTTP \(http.statusCode)"
            } else if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if isOllama {
                    names = (json["models"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
                } else {
                    names = (json["data"] as? [[String: Any]])?.compactMap { $0["id"] as? String } ?? []
                }
            } else {
                failure = "unexpected reply"
            }
            DispatchQueue.main.async {
                guard let self, request == self.modelsRequest else { return } // a newer request superseded this one
                self.loadingModels = false
                self.availableModels = names.sorted()
                if let failure {
                    self.modelsStatus = "Couldn't list models: \(failure)"
                } else if names.isEmpty {
                    self.modelsStatus = "The server has no models yet."
                }
            }
        }.resume()
    }

    var isConfigured: Bool { !(EnvFile(contentsOf: envFileURL).value("SKINNY_MODEL") ?? "").isEmpty }

    /// Returns true when saved.
    func save() -> Bool {
        env = EnvFile(contentsOf: envFileURL) // pick up edits made outside the app
        env.set("OLLAMA_API_KEY", apiKey.trimmingCharacters(in: .whitespaces))
        env.set("ANTHROPIC_API_KEY", anthropicKey.trimmingCharacters(in: .whitespaces))
        env.set("OPENAI_API_KEY", openaiKey.trimmingCharacters(in: .whitespaces))
        // An address the program would use anyway isn't written out.
        let typedHost = host.trimmingCharacters(in: .whitespaces)
        env.set("SKINNY_HOST", typedHost == SettingsModel.programHost(for: api) ? nil : typedHost)
        env.set("SKINNY_API", api == "ollama" ? nil : api)
        env.set("SKINNY_MODEL", model.trimmingCharacters(in: .whitespaces))
        env.set("SKINNY_KEEP_ALIVE", keepAlive.trimmingCharacters(in: .whitespaces))
        for setting in boolSettings {
            let value = flags[setting.key] ?? setting.defaultValue
            // Leave variables alone when the program would already do this without them.
            if value == setting.defaultValue && env.value(setting.key) == nil { continue }
            env.set(setting.key, value ? "true" : "false")
        }
        UserDefaults.standard.set(terminal, forKey: "chatIn")
        setFontSize(CGFloat(fontSize))
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

    /// A drop-down of what the server offers, refreshed whenever the server changes;
    /// a text field when it can't be listed (or on request, for a name that isn't in the list).
    @ViewBuilder private var modelRow: some View {
        let listed = !model.availableModels.isEmpty && !model.typeModelName
        HStack {
            if listed {
                Picker("Model", selection: $model.model) {
                    if SettingsModel.supportsDefaultModel(model.provider) { Text("Default (newest flagship)").tag("default") }
                    if model.model.isEmpty { Text("Choose a model…").tag("") }
                    if !model.model.isEmpty && model.model != "default" && !model.availableModels.contains(model.model) { Text(model.model).tag(model.model) }
                    ForEach(model.availableModels, id: \.self) { Text($0).tag($0) }
                }
            } else {
                TextField("Model", text: $model.model, prompt: Text("e.g. gemma4:31b"))
            }
            if model.loadingModels {
                ProgressView().controlSize(.small)
            } else {
                Button { model.refreshModels() } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh the list of models")
                    .buttonStyle(.borderless)
            }
        }
        if let status = model.modelsStatus {
            Text(status).font(.caption).foregroundStyle(.secondary)
        }
        if !model.availableModels.isEmpty {
            Toggle("Type a model name instead", isOn: $model.typeModelName).font(.caption)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Connection") {
                    Picker("Provider", selection: $model.provider) {
                        Text("Ollama (Self-Hosted)").tag("ollama-local")
                        Text("Ollama (Cloud)").tag("ollama-cloud")
                        Text("OpenAI (Cloud)").tag("openai-cloud")
                        Text("Other OpenAI-compatible").tag("openai-other")
                        Text("Anthropic (Claude)").tag("anthropic")
                    }
                    switch model.provider {
                    case "anthropic":
                        SecureField("Anthropic API key", text: $model.anthropicKey, prompt: Text("sk-ant-…"))
                    case "openai-cloud":
                        SecureField("OpenAI API key", text: $model.openaiKey, prompt: Text("sk-…"))
                        Link("Get a key at platform.openai.com/api-keys", destination: URL(string: "https://platform.openai.com/api-keys")!)
                            .font(.caption)
                    case "openai-other":
                        SecureField("API key", text: $model.openaiKey, prompt: Text("only if the server wants one"))
                    case "ollama-cloud":
                        SecureField("Ollama API key", text: $model.apiKey, prompt: Text("needed for cloud models and search"))
                        Link("Get a free key at ollama.com/settings/keys", destination: URL(string: "https://ollama.com/settings/keys")!)
                            .font(.caption)
                    default:
                        EmptyView() // a self-hosted Ollama doesn't need a key
                    }
                    TextField("Server", text: $model.host, prompt: Text(SettingsModel.suggestedHost(for: model.provider)))
                    modelRow
                    if model.managesModelLifetime {
                        TextField("Keep model loaded", text: $model.keepAlive, prompt: Text("1h"))
                    }
                }
                Section("Behavior") {
                    ForEach(boolSettings.filter { !$0.localOllamaOnly || model.managesModelLifetime }, id: \.key) { setting in
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
                        Text("SkinnyAI window").tag("builtin")
                        Text("Automatic (iTerm if installed)").tag("auto")
                        Text("Terminal").tag("terminal")
                        Text("iTerm").tag("iterm")
                    }
                    Stepper(value: $model.fontSize, in: 8...40, step: 1) {
                        Text("Font size: \(Int(model.fontSize)) pt")
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
            .onChange(of: model.host) { _ in model.scheduleRefresh() }
            .onChange(of: model.provider) { _ in model.scheduleRefresh() }
            .onChange(of: model.apiKey) { _ in if model.isOllamaCom { model.scheduleRefresh() } }
            .onChange(of: model.anthropicKey) { _ in if model.api == "anthropic" { model.scheduleRefresh() } }
            .onChange(of: model.openaiKey) { _ in if model.api == "openai" { model.scheduleRefresh() } }

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
        .frame(width: 520, height: 780)
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

// MARK: - Built-in chat windows

let defaultFontSize: CGFloat = 13

func currentFontSize() -> CGFloat {
    let saved = UserDefaults.standard.double(forKey: "fontSize")
    return saved >= 8 ? CGFloat(saved) : defaultFontSize
}

/// Remembers the size and applies it to every open chat window.
func setFontSize(_ size: CGFloat) {
    let clamped = min(40, max(8, size.rounded()))
    UserDefaults.standard.set(Double(clamped), forKey: "fontSize")
    for chat in chatWindows { chat.applyFontSize() }
}

/// A terminal view that accepts files dragged onto it, typing their paths as a paste would
/// (skinnyai recognizes the paths and attaches the files).
final class ChatTerminalView: LocalProcessTerminalView {
    private func droppedFiles(_ sender: NSDraggingInfo) -> [URL] {
        (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                               options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let files = droppedFiles(sender)
        if files.isEmpty { return false }
        // Backslash-escape anything the shell would, like Terminal.app does; each path ends in a space.
        let special = CharacterSet(charactersIn: " !\"#$&'()*;<>?[\\]^`{|}~")
        let text = files.map { url in
            String(url.path.flatMap { ch -> [Character] in
                ch.unicodeScalars.allSatisfy({ !special.contains($0) }) ? [ch] : ["\\", ch]
            })
        }.joined(separator: " ") + " "
        if getTerminal().bracketedPasteMode {
            send(txt: "\u{1b}[200~" + text + "\u{1b}[201~")
        } else {
            send(txt: text)
        }
        window?.makeFirstResponder(self)
        return true
    }
}

/// One chat: a terminal view running the bundled skinnyai binary.
final class ChatWindow: NSObject, NSWindowDelegate, LocalProcessTerminalViewDelegate {
    let window: NSWindow
    private let terminal: ChatTerminalView
    private var finished = false
    var onClose: ((ChatWindow) -> Void)?

    init(binary: String, cascadeFrom previous: NSWindow?) {
        terminal = ChatTerminalView(frame: NSRect(x: 0, y: 0, width: 900, height: 620))
        terminal.registerForDraggedTypes([.fileURL])
        terminal.font = NSFont.monospacedSystemFont(ofSize: currentFontSize(), weight: .regular)
        window = NSWindow(contentRect: terminal.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "SkinnyAI"
        // The terminal view draws right to its edges, so it sits in a container that provides the padding
        // (in the terminal's own background color, so the margin doesn't look like a frame).
        let container = NSView(frame: terminal.frame)
        container.wantsLayer = true
        container.layer?.backgroundColor = terminal.nativeBackgroundColor.cgColor
        window.backgroundColor = terminal.nativeBackgroundColor
        terminal.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(terminal)
        NSLayoutConstraint.activate([
            terminal.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            terminal.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            terminal.topAnchor.constraint(equalTo: container.topAnchor, constant: 6),
            terminal.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
        ])
        window.contentView = container
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 480, height: 300)
        if let previous { window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: previous.frame.minX, y: previous.frame.maxY))) }
        else { window.center() }
        terminal.processDelegate = self

        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        environment["TERM_PROGRAM"] = "SkinnyAI" // skinnyai draws inline images for this terminal
        terminal.startProcess(executable: binary, args: [],
                              environment: environment.map { "\($0.key)=\($0.value)" },
                              currentDirectory: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    func applyFontSize() {
        terminal.font = NSFont.monospacedSystemFont(ofSize: currentFontSize(), weight: .regular)
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(terminal)
    }

    func windowWillClose(_ notification: Notification) {
        if !finished { terminal.terminate() }
        onClose?(self)
    }

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        finished = true
        // A clean exit (/bye, Ctrl+D) closes the window; a failure stays up so its message can be read.
        if exitCode == 0 || exitCode == nil { window.close() } else { window.title = "SkinnyAI (exited with code \(exitCode ?? -1))" }
    }

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) { window.title = title.isEmpty ? "SkinnyAI" : title }
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
}

var chatWindows: [ChatWindow] = []

func openChatWindow(binary: URL) {
    let chat = ChatWindow(binary: binary.path, cascadeFrom: chatWindows.last?.window)
    chat.onClose = { closed in chatWindows.removeAll { $0 === closed } }
    chatWindows.append(chat)
    NSApp.activate(ignoringOtherApps: true)
    chat.show()
}

/// Opens a new terminal window running skinnyai. A .command file does this
/// without the Automation permission prompt that scripting the terminal would need.
func startChat() {
    guard let binary = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("skinnyai-cli"),
          FileManager.default.isExecutableFile(atPath: binary.path) else {
        alert("The skinnyai program is missing from this app.")
        return
    }
    let preference = UserDefaults.standard.string(forKey: "chatIn") ?? "builtin"
    if preference == "builtin" {
        openChatWindow(binary: URL(fileURLWithPath: binary.path))
        return
    }
    guard let app = terminalApp(preference: preference) else {
        alert("Couldn't find Terminal or iTerm.")
        return
    }
    let script = FileManager.default.temporaryDirectory.appendingPathComponent("skinnyai-\(UUID().uuidString).command")
    var body = "#!/bin/zsh\nrm -f -- \"$0\"\n"
    // The exec below keeps this shell's pid, so the app can tell whether this chat is still open.
    body += "mkdir -p \(shellQuote(homeDirectory.path)) && echo $$ > \(shellQuote(chatPidURL.path))\n"
    if let custom = ProcessInfo.processInfo.environment["SKINNY_HOME"], !custom.isEmpty { body += "export SKINNY_HOME=\(shellQuote(custom))\n" }
    body += "exec \(shellQuote(binary.path))\n"
    do {
        try body.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
    } catch {
        alert("Couldn't start a chat: \(error.localizedDescription)")
        return
    }
    UserDefaults.standard.set(Bundle(url: app)?.bundleIdentifier, forKey: "chatTerminal")
    NSWorkspace.shared.open([script], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
        if let error { DispatchQueue.main.async { alert("Couldn't open \(app.lastPathComponent): \(error.localizedDescription)") } }
    }
}

/// Whether a chat started by this app is still running.
func chatIsRunning() -> Bool {
    if !chatWindows.isEmpty { return true }
    guard let text = try? String(contentsOf: chatPidURL, encoding: .utf8),
          let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1,
          kill(pid, 0) == 0 else { return false }
    // The pid may have been reused by something else since the chat closed.
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
    return String(cString: buffer).hasSuffix("/skinnyai-cli")
}

/// Brings the terminal app holding the running chat to the front (no automation permission needed,
/// so it can't pick the exact window: the terminal shows whichever window it had in front).
func focusChat() {
    if let chat = chatWindows.last {
        NSApp.activate(ignoringOtherApps: true)
        if chat.window.isMiniaturized { chat.window.deminiaturize(nil) }
        chat.window.makeKeyAndOrderFront(nil)
        return
    }
    let id = UserDefaults.standard.string(forKey: "chatTerminal") ?? ""
    let terminal = NSRunningApplication.runningApplications(withBundleIdentifier: id).first
    if terminal?.activate(options: [.activateIgnoringOtherApps]) != true { startChat() }
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
        // Option+= / Option+- / Option+0 zoom the chat text. The terminal view would take these keys for
        // its program (Option is Meta there), so they're caught before it sees them.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
            guard let self, modifiers == .option || modifiers == [.option, .shift],
                  chatWindows.contains(where: { $0.window === NSApp.keyWindow }) else { return event }
            switch event.keyCode {
            case 24: self.biggerText(nil); return nil     // =
            case 27: self.smallerText(nil); return nil    // -
            case 29: self.actualSize(nil); return nil     // 0
            default: return event
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        openChat()
    }

    /// Switches to the chat that's already open, or starts one.
    private func openChat() {
        if !settings.isConfigured { showSettings() }
        else if chatIsRunning() { focusChat() }
        else { startChat() }
    }

    // Clicking the Dock icon again goes back to the open chat rather than starting another.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if settingsWindow?.isVisible == true { settingsWindow?.makeKeyAndOrderFront(nil) } else { openChat() }
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

    @objc func biggerText(_ sender: Any?) { zoom(to: currentFontSize() + 1) }
    @objc func smallerText(_ sender: Any?) { zoom(to: currentFontSize() - 1) }
    @objc func actualSize(_ sender: Any?) { zoom(to: defaultFontSize) }

    private func zoom(to size: CGFloat) {
        setFontSize(size)
        settings.fontSize = Double(currentFontSize()) // keeps an open Settings window in step
    }

    @objc func showHelp(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/wesbiggs/skinnyai#readme")!)
    }

    private func buildMenu() {
        let name = "SkinnyAI"
        let main = NSMenu()

        func add(_ title: String, _ menu: NSMenu, _ action: Selector?, _ key: String = "", target: AnyObject? = nil,
                 modifiers: NSEvent.ModifierFlags = .command) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
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

        let view = submenu("View")
        add("Bigger Text", view, #selector(biggerText(_:)), "=", target: self, modifiers: .option)
        add("Smaller Text", view, #selector(smallerText(_:)), "-", target: self, modifiers: .option)
        add("Actual Size", view, #selector(actualSize(_:)), "0", target: self, modifiers: .option)

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
