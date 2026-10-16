import Foundation

/// Loading state of a browser list (folder, and in later tasks recent items, search, trash).
enum LoadState: Equatable {
    case idle
    case loading
    case loaded
    /// No connection to the server: „Offline“ with „Erneut versuchen“ (no offline browsing).
    case offline
    /// The space's storage is missing (`503 space_unavailable`): „Nicht verfügbar“.
    case unavailable
    /// Any other error, with a message for the user.
    case failed(String)
}
