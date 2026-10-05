// approve-ui: the cluadex approval prompt, drawn as a Liquid Glass panel (macOS 26+).
// It prints one word (once | session | always | deny) and exits. It decides nothing
// itself: relay.mjs turns the word into an answer for the runtime.
import AppKit
import SwiftUI

struct Request {
    var app = ""                                   // what the agent asked for: bundle id, name or path
    var name = ""                                  // display name from the runtime
    var risk = ""                                  // the runtime's warning; empty unless high risk
    var options: Set<String> = ["session", "always"]
    var timeout = 120.0
    var note = ""                                  // replaces the countdown line (layout previews)
    var printWindow = false
}

func parseArguments() -> Request {
    var request = Request()
    var arguments = CommandLine.arguments.dropFirst().makeIterator()
    while let flag = arguments.next() {
        switch flag {
        case "--app": request.app = arguments.next() ?? ""
        case "--name": request.name = arguments.next() ?? ""
        case "--risk": request.risk = arguments.next() ?? ""
        case "--options": request.options = Set((arguments.next() ?? "").split(separator: ",").map(String.init))
        case "--timeout": request.timeout = Double(arguments.next() ?? "") ?? 120
        case "--note": request.note = arguments.next() ?? ""
        case "--print-window": request.printWindow = true
        default: break
        }
    }
    if request.name.isEmpty { request.name = request.app.isEmpty ? "this app" : request.app }
    return request
}

/// The icon of the app being asked about, so the prompt shows what will be controlled.
func appIcon(for request: Request) -> NSImage? {
    let files = FileManager.default
    var candidates: [String] = []
    if request.app.hasSuffix(".app") { candidates.append(request.app) }
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: request.app) { candidates.append(url.path) }
    for name in [request.name, request.app] where !name.isEmpty && !name.contains("/") {
        for folder in ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"] {
            candidates.append("\(folder)/\(name).app")
        }
    }
    guard let path = candidates.first(where: { files.fileExists(atPath: $0) }) else { return nil }
    return NSWorkspace.shared.icon(forFile: path)
}

struct Choice: Identifiable {
    let id: String
    let title: String
    let detail: String
    let symbol: String
    var prominent = false
}

// The three scopes are OpenAI's, with its meaning: each covers only the app being asked about.
func choices(for request: Request) -> [Choice] {
    var list: [Choice] = []
    if request.options.contains("once") {
        list.append(Choice(id: "once", title: "Allow once", detail: "This app only, this one time", symbol: "1.circle"))
    }
    if request.options.contains("session") {
        list.append(Choice(id: "session", title: "Allow this conversation",
                           detail: "This app only, until the conversation ends", symbol: "bubble.left.and.bubble.right"))
    }
    if request.options.contains("always") {
        list.append(Choice(id: "always", title: "Always allow", detail: "This app only, permanently, in Codex too",
                           symbol: "infinity"))
    }
    if !list.isEmpty { list[0].prominent = true }
    return list
}

struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct ChoiceRow: View {
    let choice: Choice
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: choice.symbol)
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(choice.title).font(.system(size: 13, weight: .semibold))
                    Text(choice.detail).font(.system(size: 11)).opacity(0.74).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(choice.prominent ? Color.white : Color.primary)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressStyle())
        .focusable(false)   // keys never approve; only a click does
        .onHover { hovering = $0 }
    }

    private var fill: Color {
        choice.prominent ? Color.accentColor.opacity(hovering ? 0.86 : 1) : Color.primary.opacity(hovering ? 0.14 : 0.07)
    }
}

struct DenyRow: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text("Deny")
                .font(.system(size: 13, weight: .semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Color.primary.opacity(hovering ? 0.14 : 0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressStyle())
        .focusable(false)
        .onHover { hovering = $0 }
    }
}

struct ApprovalView: View {
    let request: Request
    let icon: NSImage?
    let deadline: Date
    let finish: (String) -> Void
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 18) {
            header
            if !request.risk.isEmpty { riskNote }
            VStack(spacing: 8) {
                ForEach(choices(for: request)) { choice in
                    ChoiceRow(choice: choice) { finish(choice.id) }
                }
                DenyRow { finish("deny") }
            }
            footer
        }
        .padding(22)
        .frame(width: 360)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .padding(28)        // room for the glass shadow inside the transparent window
        .opacity(appeared ? 1 : 0)
        .scaleEffect(appeared || reduceMotion ? 1 : 0.96)
        .onAppear {
            withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.82)) { appeared = true }
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            ZStack(alignment: .bottomTrailing) {
                if let icon {
                    Image(nsImage: icon).resizable().interpolation(.high).frame(width: 64, height: 64)
                } else {
                    Image(systemName: "macwindow")
                        .font(.system(size: 34, weight: .regular))
                        .symbolRenderingMode(.hierarchical)
                        .frame(width: 64, height: 64)
                }
                Image(systemName: "cursorarrow.rays")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.accentColor, in: Circle())
                    .offset(x: 6, y: 4)
            }
            VStack(spacing: 5) {
                Text("Allow computer use to control \(request.name)?")
                    .font(.system(size: 15, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Claude Code wants to see and operate this app.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var riskNote: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.orange)
            Text(request.risk)
                .font(.system(size: 11.5))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var footer: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, Int(deadline.timeIntervalSince(context.date).rounded(.up)))
            Text(request.note.isEmpty ? "Denies by itself in \(left / 60):\(String(format: "%02d", left % 60))" : request.note)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }
}

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }   // so Esc works once the person clicks the panel
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let request: Request
    var panel: FloatingPanel?

    init(request: Request) { self.request = request }

    func finish(_ word: String) {
        print(word)
        fflush(stdout)
        exit(0)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let deadline = Date().addingTimeInterval(request.timeout)
        let view = ApprovalView(request: request, icon: appIcon(for: request), deadline: deadline) { [weak self] word in
            self?.finish(word)
        }
        let host = NSHostingView(rootView: view)
        // Non-activating and never made key on its own: it does not take the keyboard from
        // whatever the person is typing in, so no stray keystroke can answer it.
        let panel = FloatingPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                                  styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = host
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .modalPanel
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]   // show on the Space in use
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let area = screen?.visibleFrame {
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: area.maxY - size.height - area.height * 0.14))
        }
        panel.orderFrontRegardless()
        self.panel = panel
        if request.printWindow, let top = NSScreen.screens.first?.frame.maxY {
            let f = panel.frame   // printed with a top-left origin, the way screencapture -R wants it
            FileHandle.standardError.write("window \(panel.windowNumber) \(Int(f.minX)),\(Int(top - f.maxY)),\(Int(f.width)),\(Int(f.height))\n".data(using: .utf8)!)
        }

        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.finish("deny") }   // Esc
            return nil                                        // every other key is ignored
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + request.timeout) { [weak self] in self?.finish("deny") }
    }
}

@main
struct ApproveUI {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate(request: parseArguments())
        app.delegate = delegate
        app.run()
    }
}
