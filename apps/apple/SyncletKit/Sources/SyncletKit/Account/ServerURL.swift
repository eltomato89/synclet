import Foundation

/// Error of ``ServerURL/normalize(_:)``.
public enum ServerURLError: Error, Sendable, Equatable {
    case invalid
}

/// Normalizes what the user types as server address into an origin URL.
public enum ServerURL {
    /// - Adds `https://` when no scheme is given.
    /// - Keeps scheme, host (lowercased) and port; drops user info, path, query, fragment
    ///   and the trailing slash.
    /// - `http://` only for `localhost`, loopback and private IPv4 addresses (development).
    /// - Throws: ``ServerURLError/invalid`` for anything else.
    public static func normalize(_ input: String) throws -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(where: \.isWhitespace) else { throw ServerURLError.invalid }
        if !text.contains("://") { text = "https://" + text }

        guard let parsed = URLComponents(string: text),
              let scheme = parsed.scheme?.lowercased(),
              let rawHost = parsed.host, !rawHost.isEmpty else {
            throw ServerURLError.invalid
        }
        let host = rawHost.lowercased()
        switch scheme {
        case "https":
            break
        case "http":
            guard isLocalDevelopmentHost(host) else { throw ServerURLError.invalid }
        default:
            throw ServerURLError.invalid
        }
        if let port = parsed.port, !(1...65535).contains(port) { throw ServerURLError.invalid }

        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = parsed.port
        guard let url = components.url else { throw ServerURLError.invalid }
        return url
    }

    /// `localhost`, loopback (`127.0.0.0/8`, `::1`) and private IPv4 ranges
    /// (`10/8`, `172.16/12`, `192.168/16`).
    public static func isLocalDevelopmentHost(_ host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy(\.isASCII), let value = Int(part),
                  (0...255).contains(value) else { return nil }
            return value
        }
        guard octets.count == 4 else { return false }
        switch (octets[0], octets[1]) {
        case (127, _), (10, _), (192, 168): return true
        case (172, let second): return (16...31).contains(second)
        default: return false
        }
    }

    /// `host` or `host:port` of an origin – used in the domain display name.
    public static func displayHost(_ url: URL) -> String {
        let host = url.host(percentEncoded: false) ?? url.absoluteString
        if let port = url.port { return "\(host):\(port)" }
        return host
    }
}
