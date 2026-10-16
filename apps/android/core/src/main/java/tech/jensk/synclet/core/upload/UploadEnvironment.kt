package tech.jensk.synclet.core.upload

import tech.jensk.synclet.core.api.SyncItem

/** What the worker needs from the app (implemented by AppGraph). */
interface UploadEnvironment {
    val uploadQueue: UploadQueue
    /** Uploader of the account, or null when the account no longer exists (signed out). */
    fun uploader(accountKey: String): Uploader?
    /** After a successful upload: invalidate listings, notify the provider and visible views. */
    fun onUploadFinished(entry: UploadEntry, item: SyncItem)

    interface Owner { val uploadEnvironment: UploadEnvironment }
}
