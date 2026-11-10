import AppIntents
import ImageIO
import SwiftUI
import WidgetKit

enum InteractionAction: String, AppEnum, Codable {
    case head, hand, hug, sing

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "互動動作"
    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .head: "摸頭", .hand: "牽手", .hug: "擁抱", .sing: "唱歌",
    ]

    var label: String {
        switch self {
        case .head: "摸頭"
        case .hand: "牽手"
        case .hug: "擁抱"
        case .sing: "唱歌"
        }
    }
}

struct InteractIntent: AppIntent {
    static let title: LocalizedStringResource = "INORI 房間互動"
    static let isDiscoverable = false

    @Parameter(title: "動作")
    var action: InteractionAction

    init() {}
    init(_ action: InteractionAction) { self.action = action }

    func perform() async throws -> some IntentResult {
        await WidgetRoom.shared.send(action)
        return .result()
    }
}

struct RoomEntry: TimelineEntry {
    let date = Date()
    var snapshot: RoomSnapshot?
    var status: String?
}

private actor WidgetRoom {
    static let shared = WidgetRoom()

    private struct Pending: Codable {
        let id: UUID
        let action: InteractionAction
        let started: Date
    }

    private struct Cache: Codable {
        let connectionId: UUID
        var snapshot: RoomSnapshot?
        var fetchedAt: Date?
        var status: String?
        var pending: Pending?
    }

    private let storageKey = "INORI.RoomWidget"
    private var sending = false

    private func cache(for connection: RoomConnection) -> Cache {
        if let saved = UserDefaults.standard.data(forKey: storageKey),
           let cached = try? JSONDecoder().decode(Cache.self, from: saved), cached.connectionId == connection.id {
            return cached
        }
        return Cache(connectionId: connection.id)
    }

    private func save(_ cache: Cache) {
        guard (try? RoomConnection.load())?.id == cache.connectionId else { return }
        if let encoded = try? JSONEncoder().encode(cache) {
            UserDefaults.standard.set(encoded, forKey: storageKey)
        }
    }

    func entry(refresh: Bool) async -> RoomEntry {
        let connection: RoomConnection
        do {
            guard let paired = try RoomConnection.load() else {
                UserDefaults.standard.removeObject(forKey: storageKey)
                return RoomEntry(status: "打開 INORI 配對房間")
            }
            connection = paired
        } catch {
            return RoomEntry(status: "無法讀取配對。請打開 INORI。")
        }

        var current = cache(for: connection)
        if refresh, !sending, Date().timeIntervalSince(current.fetchedAt ?? .distantPast) > 5 {
            do {
                let snapshot = try await RoomAPI.snapshot(connection)
                current = cache(for: connection)
                if snapshot.revision >= (current.snapshot?.revision ?? 0) {
                    current.snapshot = snapshot
                    current.fetchedAt = Date()
                    save(current)
                }
            } catch {
                current = cache(for: connection)
                if (error as? RoomError)?.status == 401 {
                    save(Cache(connectionId: connection.id))
                    return RoomEntry(status: "配對已失效。請打開 INORI 重新配對。")
                }
                current.status = current.status ?? "暫時連不上房間"
            }
        }
        guard (try? RoomConnection.load())?.id == connection.id else {
            return RoomEntry(status: "打開 INORI 配對房間")
        }
        return RoomEntry(snapshot: current.snapshot, status: current.status)
    }

    func send(_ action: InteractionAction) async {
        guard !sending, let connection = try? RoomConnection.load() else { return }
        sending = true
        defer { sending = false }
        var current = cache(for: connection)
        let pending: Pending
        if let previous = current.pending, Date().timeIntervalSince(previous.started) < 600 {
            guard previous.action == action else {
                current.status = "請先再按一次「\(previous.action.label)」。"
                save(current)
                return
            }
            pending = previous
        } else {
            pending = Pending(id: UUID(), action: action, started: Date())
        }
        current.pending = pending
        current.status = nil
        save(current)
        do {
            let snapshot = try await RoomAPI.interact(connection, id: pending.id, action: action.rawValue)
            current = cache(for: connection)
            current.pending = nil
            if snapshot.revision >= (current.snapshot?.revision ?? 0) {
                current.snapshot = snapshot
                current.fetchedAt = Date()
            }
            save(current)
        } catch {
            let problem = error as? RoomError
            if problem?.status == 401 {
                save(Cache(connectionId: connection.id, status: "配對已失效。請打開 INORI 重新配對。"))
                return
            }
            current = cache(for: connection)
            if let problem, (400..<500).contains(problem.status), ![409, 429].contains(problem.status) {
                current.pending = nil
            }
            current.status = problem?.message ?? "尚未收到回覆，請再按一次「\(action.label)」。"
            save(current)
        }
    }
}

struct RoomProvider: TimelineProvider {
    func placeholder(in context: Context) -> RoomEntry {
        RoomEntry(snapshot: RoomSnapshot(revision: 0, name: "INORI", greeting: "在房間裡見。", mood: "普通", todayCount: 0, portrait: nil, interaction: nil))
    }

    func getSnapshot(in context: Context, completion: @escaping (RoomEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)) }
        else { Task { await completion(WidgetRoom.shared.entry(refresh: false)) } }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RoomEntry>) -> Void) {
        Task {
            let entry = await WidgetRoom.shared.entry(refresh: true)
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }
}

struct RoomWidgetView: View {
    let entry: RoomEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let room = entry.snapshot {
                HStack(alignment: .top, spacing: 9) {
                    portrait(room.portrait)
                        .frame(width: 43, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        .privacySensitive()
                    VStack(alignment: .leading, spacing: 3) {
                        Text(room.name).font(.headline).lineLimit(1)
                        Text(room.interaction?.reply ?? room.greeting)
                            .font(.caption).lineLimit(2)
                    }
                    .privacySensitive()
                    Spacer(minLength: 0)
                }
                Text(entry.status ?? caption(room))
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.78))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    ForEach(InteractionAction.allCases, id: \.self) { action in
                        Button(intent: InteractIntent(action)) {
                            Text(action.label)
                                .font(.caption.bold())
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.mini)
                .tint(Color(red: 0.46, green: 0.23, blue: 0.39))
            } else {
                Text("✦ INORI").font(.headline)
                Text(entry.status ?? "正在讀取房間…").font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            Color(red: 0.19, green: 0.12, blue: 0.20)
        }
        .foregroundStyle(.white)
    }

    private func caption(_ room: RoomSnapshot) -> String {
        let interaction = room.interaction.map { $0.label + " · " } ?? ""
        let source = room.interaction?.source == "built-in" ? " · 備用回應" : ""
        return interaction + "今日 \(room.todayCount) 次" + source
    }

    @ViewBuilder
    private func portrait(_ uri: String?) -> some View {
        if let uri, let comma = uri.firstIndex(of: ","),
           ["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"].contains(String(uri[..<comma])),
           let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])),
           let source = CGImageSourceCreateWithData(data as CFData, nil),
           let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
               kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceThumbnailMaxPixelSize: 144,
           ] as CFDictionary) {
            Image(decorative: image, scale: 1).resizable().scaledToFill()
        } else {
            Image(systemName: "sparkle")
                .font(.title2)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.white.opacity(0.1))
                .accessibilityHidden(true)
        }
    }
}

@main
struct INORIWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "INORIWidget", provider: RoomProvider()) { entry in
            RoomWidgetView(entry: entry)
        }
        .configurationDisplayName("INORI")
        .description("在主畫面和房間角色互動。")
        .supportedFamilies([.systemMedium])
    }
}
