package tech.jensk.synclet.core.events

sealed interface SyncEvent {
    data class Hello(val cursor: String, val cursors: Map<String, String>) : SyncEvent
    data class Changes(val space: String, val cursor: String) : SyncEvent
    data object AccountChanged : SyncEvent
    data class Bye(val reason: String) : SyncEvent
}

enum class StreamState { IDLE, CONNECTING, CONNECTED, BACKING_OFF, SIGN_IN_REQUIRED }

sealed interface Disconnect {
    data object Network : Disconnect
    data class Http(val status: Int, val retryAfterSeconds: Long?) : Disconnect
    data object NotEventStream : Disconnect
    data class Bye(val reason: String) : Disconnect
    data object Closed : Disconnect
    data object Unauthorized : Disconnect
}

/** What the app should reload after events, polling or own mutations. */
sealed interface FolderChange {
    val accountKey: String
    data class Folders(override val accountKey: String, val folderIds: Set<String>) : FolderChange
    data class Everything(override val accountKey: String) : FolderChange
}
