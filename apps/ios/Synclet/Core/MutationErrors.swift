import Foundation
import SyncletKit

/// What became of a change made in the browser (create, rename, move, delete).
enum MutationOutcome: Equatable {
    case ok
    /// `412 conflict`: the item changed on the server; the view reloaded, nothing is retried.
    case conflictReloaded
    /// `409 name_conflict`: the name sheet stays open.
    case nameTaken
    /// `404`: the item is gone; the view reloaded.
    case gone
    /// `400 invalid_name` (or the local pre-check), with the message to show inline.
    case invalidName(String)
    /// No connection to the server.
    case offline
    case failed(String)
}

/// Maps Sync API errors to ``MutationOutcome``s and their messages (spec §2.8).
enum MutationErrors {
    static func outcome(for error: Error) -> MutationOutcome {
        if error is URLError { return .offline }
        guard let apiError = error as? SyncAPIError else {
            return .failed(error.localizedDescription)
        }
        switch apiError {
        case .conflict: return .conflictReloaded
        case .nameConflict: return .nameTaken
        case .notFound: return .gone
        case .invalidName(let message):
            return .invalidName(message ?? apiError.localizedDescription)
        case .transport: return .offline
        case .invalidMove(let message?), .invalidRequest(let message?), .forbidden(let message?):
            return .failed(message)
        default:
            return .failed(apiError.localizedDescription)
        }
    }

    /// The message for the user; `nil` for ``MutationOutcome/ok``.
    static func message(_ outcome: MutationOutcome) -> String? {
        switch outcome {
        case .ok: return nil
        case .conflictReloaded: return String(localized: "Changed in the meantime")
        case .nameTaken: return String(localized: "Name already taken")
        case .gone: return String(localized: "No longer exists")
        case .invalidName(let message): return message
        case .offline: return String(localized: "You are offline. Please try again later.")
        case .failed(let message): return message
        }
    }

    /// Characters the server (and Windows clients) reject in names.
    static let forbiddenCharacters = CharacterSet(charactersIn: "/\\:*?\"<>|")

    /// Local pre-check of a new name; `nil` when it may be sent. The server stays authoritative.
    static func nameProblem(_ name: String) -> String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(localized: "Please enter a name.")
        }
        if name.rangeOfCharacter(from: forbiddenCharacters) != nil {
            return String(localized: "Names can’t contain / \\ : * ? \" < > |")
        }
        if name.utf8.count > 255 {
            return String(localized: "The name is too long.")
        }
        return nil
    }
}
