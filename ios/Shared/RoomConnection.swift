import Foundation
import Security

struct RoomConnection: Codable {
    let id: UUID
    let origin: URL
    let token: String

    private static let keychainQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "INORI.RoomConnection",
        kSecAttrAccount as String: "device",
    ]

    static func load() throws -> Self? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data else { throw RoomError(message: "無法讀取配對。") }
        return try JSONDecoder().decode(Self.self, from: data)
    }

    func save() throws {
        let data = try JSONEncoder().encode(self)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(Self.keychainQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = Self.keychainQuery
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            try Self.check(SecItemAdd(item as CFDictionary, nil))
        } else {
            try Self.check(status)
        }
    }

    static func remove() throws {
        let status = SecItemDelete(keychainQuery as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else {
            throw RoomError(message: "無法使用手機的配對儲存空間（\(status)）。")
        }
    }
}

struct RoomError: LocalizedError {
    var status = 0
    let message: String
    var errorDescription: String? { message }
}

struct RoomSnapshot: Codable {
    struct Interaction: Codable {
        let label: String
        let reply: String
        let source: String?
    }

    let revision: Int
    let name: String
    let greeting: String
    let mood: String
    let todayCount: Int
    let portrait: String?
    let interaction: Interaction?
}

private final class RoomRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum RoomAPI {
    private struct PairRequest: Encodable { let code: String }
    private struct PairResponse: Decodable { let token: String }
    private struct InteractionRequest: Encodable { let id: UUID; let type: String }
    private struct ErrorResponse: Decodable { let error: String }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 38
        config.timeoutIntervalForResource = 40
        return URLSession(configuration: config, delegate: RoomRedirectDelegate(), delegateQueue: nil)
    }()

    static func pair(_ value: String) async throws -> RoomConnection {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil,
              parts.path == "/" || parts.path.isEmpty,
              let fragment = parts.fragment, fragment.hasPrefix("pair="),
              validToken(String(fragment.dropFirst(5))) else {
            throw RoomError(message: "請從房間設定複製完整的 iPhone 配對資訊。")
        }
        #if targetEnvironment(simulator)
        let secure = parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
        #else
        let secure = parts.scheme == "https"
        #endif
        guard secure else { throw RoomError(message: "配對需要 HTTPS 房間網址。") }
        parts.fragment = nil
        guard let origin = parts.url else { throw RoomError(message: "房間網址無效。") }
        let body = try JSONEncoder().encode(PairRequest(code: String(fragment.dropFirst(5))))
        let result: PairResponse = try await request(origin, "widget-pair", body: body)
        guard validToken(result.token) else { throw RoomError(message: "房間回傳的配對資料無效。") }
        return RoomConnection(id: UUID(), origin: origin, token: result.token)
    }

    static func snapshot(_ connection: RoomConnection) async throws -> RoomSnapshot {
        try await request(connection.origin, "widget-native", token: connection.token)
    }

    static func interact(_ connection: RoomConnection, id: UUID, action: String) async throws -> RoomSnapshot {
        let body = try JSONEncoder().encode(InteractionRequest(id: id, type: action))
        return try await request(connection.origin, "widget-native", token: connection.token, body: body)
    }

    private static func validToken(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    private static func request<T: Decodable>(_ origin: URL, _ path: String, token: String? = nil, body: Data? = nil) async throws -> T {
        let url = origin.appendingPathComponent("api").appendingPathComponent(path)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RoomError(message: "房間服務回應無效。") }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error)
            throw RoomError(status: http.statusCode, message: message ?? "房間服務暫時無法使用（\(http.statusCode)）。")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
