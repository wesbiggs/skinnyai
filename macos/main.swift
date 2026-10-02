// SkinnyAI.app: a thin native shell around the bundled `skinnyai` binary.
// It runs chats in its own terminal windows (SwiftTerm), or in Terminal.app /
// iTerm2 if preferred, and provides a Settings window (Cmd-,) that edits
// ~/.skinny/config.json.

import AppKit
import SwiftTerm
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Paths

let homeDirectory: URL = {
    if let custom = ProcessInfo.processInfo.environment["SKINNY_HOME"], !custom.isEmpty {
        return URL(fileURLWithPath: custom)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".skinny")
}()
let configFileURL = homeDirectory.appendingPathComponent("config.json")
let sessionsURL = homeDirectory.appendingPathComponent("sessions")
/// The running chat's process id, written by the launcher script (which then execs the chat, keeping the pid).
let chatPidURL = homeDirectory.appendingPathComponent("app-chat.pid")

// MARK: - config.json
// Named profiles, each with an "env" block (the variables the program reads) and optional "mcpServers".
// Every other profile inherits from Default, as in bin/skinnyai.js (resolveProfile). Anything this app
// doesn't manage (other variables, MCP servers, other top-level keys) is kept as it was.

struct ConfigFile {
    static let defaultName = "Default"
    private(set) var root: [String: Any]

    init() {
        if let data = try? Data(contentsOf: configFileURL),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           object["profiles"] is [String: Any] {
            root = object
            return
        }
        root = ["profiles": [Self.defaultName: ["env": [String: String]()]]]
    }

    private var profiles: [String: Any] { root["profiles"] as? [String: Any] ?? [:] }

    /// Default first, then the rest alphabetically.
    var profileNames: [String] {
        let others = profiles.keys.filter { $0 != Self.defaultName }.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        return [Self.defaultName] + others
    }

    func has(_ name: String) -> Bool { name == Self.defaultName || profiles[name] != nil }

    private static func text(_ value: Any) -> String? {
        if value is NSNull { return nil }
        if let number = value as? NSNumber {
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
        }
        return value as? String
    }

    /// The variables a profile sets itself.
    func ownEnv(_ name: String) -> [String: String] {
        let block = (profiles[name] as? [String: Any])?["env"] as? [String: Any] ?? [:]
        return block.compactMapValues { Self.text($0) }
    }

    /// What a chat using the profile sees: its variables over Default's.
    func effectiveEnv(_ name: String) -> [String: String] {
        name == Self.defaultName ? ownEnv(name) : ownEnv(Self.defaultName).merging(ownEnv(name)) { _, own in own }
    }

    /// Sets `managed` variables in a profile (creating it): an empty value means "unset". A non-Default
    /// profile only stores what differs from Default's, and an empty string where Default has a value.
    mutating func save(profile name: String, values: [String: String], managed: [String]) {
        var own = (profiles[name] as? [String: Any])?["env"] as? [String: Any] ?? [:]
        let base = name == Self.defaultName ? [:] : effectiveEnv(Self.defaultName)
        for key in managed {
            let value = values[key] ?? ""
            if value == (base[key] ?? "") { own[key] = nil } else { own[key] = value }
        }
        var all = profiles
        var block = all[name] as? [String: Any] ?? [:]
        block["env"] = own
        all[name] = block
        root["profiles"] = all
    }

    func write() throws {
        try FileManager.default.createDirectory(at: homeDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try (data + Data("\n".utf8)).write(to: configFileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configFileURL.path) // it may hold API keys
    }
}

/// "Ollama, gemma4:31b": the protocol and model a profile connects with.
func profileSummary(_ name: String) -> String {
    let env = ConfigFile().effectiveEnv(name)
    let protocolName: String
    switch env["SKINNY_API"] ?? "" {
    case "anthropic": protocolName = "Anthropic"
    case "openai": protocolName = "OpenAI"
    default: protocolName = "Ollama"
    }
    let model = env["SKINNY_MODEL"] ?? ""
    return model.isEmpty ? "\(protocolName), no model chosen" : "\(protocolName), \(model)"
}

/// The profile chats started from this app use, if it still exists.
func activeProfileName() -> String {
    let saved = UserDefaults.standard.string(forKey: "profile") ?? ConfigFile.defaultName
    return ConfigFile().has(saved) ? saved : ConfigFile.defaultName
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
    /// A confirmation shown where the hint usually is, e.g. after "Save to Profile".
    @Published var savedNote: String?
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

    private var config = ConfigFile()
    /// The profile being edited (chats use it too once saved).
    @Published var profile = ConfigFile.defaultName
    @Published var profileNames = [ConfigFile.defaultName]

    init() { load() }

    func load() {
        config = ConfigFile()
        profileNames = config.profileNames
        profile = activeProfileName()
        loadFields()
    }

    /// Switches the form to another profile's settings (unsaved edits are dropped).
    func select(profile name: String) {
        guard config.has(name) else { return }
        profile = name
        message = nil
        loadFields()
    }

    private func loadFields() {
        loading = true
        defer { loading = false }
        let env = config.effectiveEnv(profile)
        fontSize = Double(currentFontSize())
        apiKey = env["OLLAMA_API_KEY"] ?? ""
        anthropicKey = env["ANTHROPIC_API_KEY"] ?? ""
        openaiKey = env["OPENAI_API_KEY"] ?? ""
        let savedAPI = env["SKINNY_API"] ?? ""
        let savedHost = env["SKINNY_HOST"]
        let savedProgramAPI = ["openai", "anthropic"].contains(savedAPI) ? savedAPI : "ollama"
        let effectiveHost = savedHost ?? SettingsModel.programHost(for: savedProgramAPI)
        provider = SettingsModel.provider(api: savedProgramAPI, host: effectiveHost)
        host = effectiveHost
        model = env["SKINNY_MODEL"] ?? ""
        keepAlive = env["SKINNY_KEEP_ALIVE"] ?? ""
        for setting in boolSettings {
            flags[setting.key] = parseBool(env[setting.key]) ?? setting.defaultValue
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

    var isConfigured: Bool {
        let file = ConfigFile()
        let name = file.has(activeProfileName()) ? activeProfileName() : ConfigFile.defaultName
        return !(file.effectiveEnv(name)["SKINNY_MODEL"] ?? "").isEmpty
    }

    /// Writes the form into the profile `name` (creating it), and makes it the one chats use.
    /// Returns true when saved.
    private func store(in name: String) -> Bool {
        config = ConfigFile() // pick up edits made outside the app
        let existing = config.effectiveEnv(name)
        let typedHost = host.trimmingCharacters(in: .whitespaces)
        var values: [String: String] = [
            "OLLAMA_API_KEY": apiKey.trimmingCharacters(in: .whitespaces),
            "ANTHROPIC_API_KEY": anthropicKey.trimmingCharacters(in: .whitespaces),
            "OPENAI_API_KEY": openaiKey.trimmingCharacters(in: .whitespaces),
            // An address the program would use anyway isn't written out.
            "SKINNY_HOST": typedHost == SettingsModel.programHost(for: api) ? "" : typedHost,
            "SKINNY_API": api == "ollama" ? "" : api,
            "SKINNY_MODEL": model.trimmingCharacters(in: .whitespaces),
            "SKINNY_KEEP_ALIVE": keepAlive.trimmingCharacters(in: .whitespaces),
        ]
        for setting in boolSettings {
            let value = flags[setting.key] ?? setting.defaultValue
            // Leave variables alone when the program would already do this without them.
            let skip = value == setting.defaultValue && existing[setting.key] == nil
            values[setting.key] = skip ? "" : (value ? "true" : "false")
        }
        config.save(profile: name, values: values, managed: Array(values.keys))
        UserDefaults.standard.set(terminal, forKey: "chatIn")
        UserDefaults.standard.set(name, forKey: "profile")
        setFontSize(CGFloat(fontSize))
        do {
            try config.write()
            profileNames = config.profileNames
            profile = name
            message = nil
            return true
        } catch {
            message = "Couldn't save: \(error.localizedDescription)"
            return false
        }
    }

    /// Saves the form over the selected profile.
    func save() -> Bool { store(in: profile) }

    /// Saves the form as a new profile and switches to it. Returns false (with a message) if the name won't do.
    func createProfile(named raw: String) -> Bool {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return false }
        if ConfigFile().profileNames.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
            message = "A profile named \(name) already exists."
            return false
        }
        return store(in: name)
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
                Section("Profile") {
                    Picker("Profile", selection: Binding(get: { model.profile }, set: { model.select(profile: $0) })) {
                        ForEach(model.profileNames, id: \.self) { Text($0).tag($0) }
                    }
                    HStack {
                        Button("Save to Profile") { if model.save() { model.message = nil; model.savedNote = "Saved to \(model.profile)." } }
                            .help("Overwrite this profile with the settings below")
                        Button("New Profile…") {
                            if let name = promptForProfileName(), model.createProfile(named: name) { model.savedNote = "Created \(name)." }
                        }
                        .help("Save the settings below as a new profile")
                    }
                }
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
                        Button("Open config.json in Editor") { NSWorkspace.shared.open(ensureConfigFile()) }
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
                    Text(model.savedNote ?? "Changes apply to chats you start afterwards, using the \(model.profile) profile.").font(.caption).foregroundStyle(.secondary)
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

/// The first window: pick a profile (the last one used is pre-selected), then start a chat, open a saved one,
/// or adjust settings.
struct StartView: View {
    let names: [String]
    let summaries: [String: String]
    @State var selected: String
    var onNewChat: (String) -> Void
    var onOpenChat: (String) -> Void
    var onSettings: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Picker("Profile", selection: $selected) {
                        ForEach(names, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: .infinity)
                    Button("New Chat") { onNewChat(selected) }
                        .keyboardShortcut(.defaultAction)
                }
                Text(summaries[selected] ?? "").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Settings...") { onSettings(selected) }
                    Button("Open Chat...") { onOpenChat(selected) }
                }
                .padding(.top, 4)
            }
        }
        .padding(24)
        .frame(width: 440)
    }
}

func ensureConfigFile() -> URL {
    if !FileManager.default.fileExists(atPath: configFileURL.path) {
        try? ConfigFile().write()
    }
    return configFileURL
}

/// Asks for a line of text in a small dialog; nil if cancelled or left empty.
func promptForText(title: String, detail: String, placeholder: String, initial: String = "", button: String) -> String? {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    field.placeholderString = placeholder
    field.stringValue = initial
    alert.accessoryView = field
    alert.addButton(withTitle: button)
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
}

/// Asks for the name of a new profile; nil if cancelled.
func promptForProfileName() -> String? {
    promptForText(title: "New profile", detail: "The current settings are saved under this name.", placeholder: "e.g. Work", button: "Create")
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
    /// The name the chat is saved under, as announced by the program in the window title.
    var savedName: String?
    var onClose: ((ChatWindow) -> Void)?

    init(binary: String, arguments: [String] = [], cascadeFrom previous: NSWindow?) {
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
        terminal.startProcess(executable: binary, args: arguments,
                              environment: environment.map { "\($0.key)=\($0.value)" },
                              currentDirectory: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    func applyFontSize() {
        terminal.font = NSFont.monospacedSystemFont(ofSize: currentFontSize(), weight: .regular)
    }

    /// Types a line into the chat, as if the user had entered it.
    func submit(_ line: String) {
        terminal.send(txt: line.replacingOccurrences(of: "\n", with: " ") + "\r")
        window.makeFirstResponder(terminal)
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

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        window.title = title.isEmpty ? "SkinnyAI" : title
        // skinnyai titles the window "SkinnyAI: <name>" once the chat has a saved-session name. A name it
        // gave itself (autosave) doesn't count: Save should still ask.
        let prefix = "SkinnyAI: "
        let name = title.hasPrefix(prefix) ? String(title.dropFirst(prefix.count)) : nil
        let isAutosaveName = name?.range(of: #"^chat-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$"#, options: .regularExpression) != nil
        savedName = isAutosaveName ? nil : name
    }
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
}

var chatWindows: [ChatWindow] = []

func openChatWindow(binary: URL, arguments: [String] = [], savedName: String? = nil) {
    let chat = ChatWindow(binary: binary.path, arguments: arguments, cascadeFrom: chatWindows.last?.window)
    chat.savedName = savedName
    chat.onClose = { closed in chatWindows.removeAll { $0 === closed } }
    chatWindows.append(chat)
    NSApp.activate(ignoringOtherApps: true)
    chat.show()
}

/// Opens a new terminal window running skinnyai. A .command file does this
/// without the Automation permission prompt that scripting the terminal would need.
func startChat(session: String? = nil) {
    // Chats use the profile picked in Settings (Default needs no flag).
    let profile = activeProfileName()
    let profileArgs = (profile == ConfigFile.defaultName ? [] : ["--profile", profile]) + (session.map { [$0] } ?? [])
    guard let binary = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("skinnyai-cli"),
          FileManager.default.isExecutableFile(atPath: binary.path) else {
        alert("The skinnyai program is missing from this app.")
        return
    }
    let preference = UserDefaults.standard.string(forKey: "chatIn") ?? "builtin"
    if preference == "builtin" {
        openChatWindow(binary: URL(fileURLWithPath: binary.path), arguments: profileArgs, savedName: session)
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
    body += "exec \(([shellQuote(binary.path)] + profileArgs.map(shellQuote)).joined(separator: " "))\n"
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
    private var startWindow: NSWindow?
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
        showStart()
    }

    /// The start screen, with the last-used profile selected.
    private func showStart() {
        if let existing = startWindow, existing.isVisible { existing.makeKeyAndOrderFront(nil); return }
        let names = ConfigFile().profileNames
        let view = StartView(
            names: names,
            summaries: Dictionary(uniqueKeysWithValues: names.map { ($0, profileSummary($0)) }),
            selected: activeProfileName(),
            onNewChat: { [weak self] name in
                UserDefaults.standard.set(name, forKey: "profile")
                self?.startWindow?.close()
                self?.openChat()
            },
            onOpenChat: { [weak self] name in
                UserDefaults.standard.set(name, forKey: "profile")
                self?.openSavedChat(nil)
            },
            onSettings: { [weak self] name in
                UserDefaults.standard.set(name, forKey: "profile")
                self?.startWindow?.close()
                self?.showSettings()
            }
        )
        let window = NSWindow(contentViewController: NSHostingController(rootView: view))
        window.title = "SkinnyAI"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        window.center()
        startWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Switches to the chat that's already open, or starts one.
    private func openChat() {
        if !settings.isConfigured { showSettings() }
        else if chatIsRunning() { focusChat() }
        else { startChat() }
    }

    // Clicking the Dock icon again goes back to the open chat rather than starting another.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if settingsWindow?.isVisible == true { settingsWindow?.makeKeyAndOrderFront(nil) }
        else if chatIsRunning() { focusChat() }
        else { showStart() }
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Lets the user pick a saved chat (from ~/.skinny/sessions) and resumes it.
    @objc func openSavedChat(_ sender: Any?) {
        guard settings.isConfigured else { showSettings(); return }
        try? FileManager.default.createDirectory(at: sessionsURL, withIntermediateDirectories: true)
        let panel = NSOpenPanel()
        panel.title = "Open Chat"
        panel.directoryURL = sessionsURL
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType(filenameExtension: "Modelfile") ?? .data]
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard url.deletingLastPathComponent().standardizedFileURL == sessionsURL.standardizedFileURL else {
            alert("Choose a chat saved in \(sessionsURL.path).")
            return
        }
        startWindow?.close()
        startChat(session: url.deletingPathExtension().lastPathComponent)
    }

    @objc func newChat(_ sender: Any?) { showStart() }

    private var frontChat: ChatWindow? { chatWindows.first { $0.window === NSApp.keyWindow } }

    /// Saves the front chat under its name, asking for one first if it has none.
    @objc func saveChat(_ sender: Any?) {
        guard let chat = frontChat else { return }
        if chat.savedName != nil { chat.submit("/save") } else { saveChatAs(sender) }
    }

    /// Asks for a name and saves the front chat under it, like `/save <name>`.
    @objc func saveChatAs(_ sender: Any?) {
        guard let chat = frontChat,
              let name = promptForText(title: "Save Chat", detail: "Name for the saved chat (resume it later with Open Chat…).",
                                       placeholder: "e.g. trip-planning", initial: chat.savedName ?? "", button: "Save") else { return }
        chat.submit("/save \(name)")
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(saveChat(_:)) || item.action == #selector(saveChatAs(_:)) { return frontChat != nil }
        return true
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
        add("Open Chat…", file, #selector(openSavedChat(_:)), "o", target: self)
        file.addItem(.separator())
        add("Save", file, #selector(saveChat(_:)), "s", target: self)
        add("Save As…", file, #selector(saveChatAs(_:)), "S", target: self)

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
