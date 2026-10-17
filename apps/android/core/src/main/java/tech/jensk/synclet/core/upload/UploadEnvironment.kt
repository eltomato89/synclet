package tech.jensk.synclet.core.upload

import tech.jensk.synclet.core.api.SyncItem

/** What the worker needs from the app (implemented by AppGraph). */
interface UploadEnvironment {
    val uploadQueue: UploadQueue
    /**
     * Accounts and their sessions are loaded (AppGraph's ready gate). A worker started by WorkManager in a cold
     * process must wait for it before asking for an uploader; it throws when loading failed.
     */
    suspend fun awaitReady()
    /** Uploader of the account, or null when the account no longer exists (signed out). */
    fun uploader(accountKey: String): Uploader?
    /** After a successful upload: invalidate listings, notify the provider and visible views. */
    fun onUploadFinished(entry: UploadEntry, item: SyncItem)

    interface Owner { val uploadEnvironment: UploadEnvironment }
}
