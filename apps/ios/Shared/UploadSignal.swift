import Foundation
import SyncletKit

/// Background-session identifiers and the Darwin notification the Share extension posts after
/// every write to the upload queue (the app listens and refreshes its list).
enum UploadSignal {
    /// Session of the app's ``BackgroundUploader``.
    static let appSessionIdentifier = "tech.jensk.synclet.upload.app"
    /// Owner of the uploads the app runs in its foreground session while it is active.
    static let appForegroundIdentifier = "tech.jensk.synclet.upload.app.foreground"
    /// Session of the Share extension's ``BackgroundUploader``.
    static let shareSessionIdentifier = "tech.jensk.synclet.upload.share"
    static let notificationName = "tech.jensk.synclet.uploadsChanged"

    static func post() {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(notificationName as CFString), nil, nil, true)
    }
}

extension UploadFailure {
    /// Short text for a failed upload (uploads list).
    var displayText: String {
        switch self {
        case .insufficientStorage: return String(localized: "Storage Full")
        case .targetGone: return String(localized: "Target Folder Deleted")
        case .signedOut: return String(localized: "Sign In Again")
        case .tooLarge: return String(localized: "File Too Large")
        case .invalidName: return String(localized: "Invalid Name")
        case .network: return String(localized: "No Connection")
        case .sourceUnreadable: return String(localized: "File Not Readable")
        case .other: return String(localized: "Error")
        case .readOnly: return String(localized: "Read Only")
        case .spaceUnavailable: return String(localized: "Space Not Available")
        }
    }
}
