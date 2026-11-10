import SwiftUI
import WidgetKit

@main
struct INORIApp: App {
    @State private var connection: RoomConnection?
    @State private var code = ""
    @State private var status = ""
    @State private var busy = false

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                Form {
                    if let connection {
                        Section("已配對的房間") {
                            Link(connection.origin.host ?? "開啟房間", destination: connection.origin)
                            Text("回到 iPhone 主畫面，在 INORI 中尺寸小工具點選動作。")
                            Button("清除手機上的配對", role: .destructive) { unpair() }
                                .disabled(busy)
                        }
                    }
                    Section(connection == nil ? "配對房間" : "重新配對") {
                        Text("在 INORI 網頁的「房間設定 → 主畫面小工具」產生 iPhone 配對碼，複製後貼在這裡。")
                        SecureField("貼上 iPhone 配對資訊", text: $code)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(busy)
                        Button(busy ? "配對中…" : "配對") { Task { await pair() } }
                            .disabled(code.isEmpty || busy)
                    }
                    if !status.isEmpty {
                        Text(status)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("pairing-status")
                    }
                }
                .navigationTitle("INORI")
                .task { await load() }
            }
        }
    }

    @MainActor
    private func load() async {
        do { connection = try RoomConnection.load() }
        catch { status = error.localizedDescription }
        guard let current = connection else { return }
        do { _ = try await RoomAPI.snapshot(current) }
        catch {
            if connection?.id == current.id && !busy { status = error.localizedDescription }
        }
    }

    @MainActor
    private func pair() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        status = ""
        do {
            let paired = try await RoomAPI.pair(code)
            try paired.save()
            connection = paired
            code = ""
            status = "配對完成。請回到主畫面使用 INORI 小工具。"
            WidgetCenter.shared.reloadTimelines(ofKind: "INORIWidget")
        } catch {
            status = error.localizedDescription
        }
    }

    private func unpair() {
        do {
            try RoomConnection.remove()
            connection = nil
            status = "已清除手機上的配對。"
            WidgetCenter.shared.reloadTimelines(ofKind: "INORIWidget")
        } catch {
            status = error.localizedDescription
        }
    }
}
