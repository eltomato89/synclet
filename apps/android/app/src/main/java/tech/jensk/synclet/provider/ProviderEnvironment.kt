package tech.jensk.synclet.provider

import java.io.File
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.cache.FileCache
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.upload.UploadQueue

/** What the DocumentsProvider needs from the app (implemented by AppGraph). */
interface ProviderEnvironment {
    /** Accounts and the upload queue are loaded. */
    suspend fun awaitReady()
    fun accounts(): List<Account>
    fun session(accountKey: String): AccountSession?
    val listingCache: ListingCache
    val fileCache: FileCache
    val uploadQueue: UploadQueue
    val notifier: ProviderNotifier
    val deviceName: String
    fun scheduleUploads(accountKey: String)
    suspend fun thumbnailFile(accountKey: String, item: SyncItem, size: Int): File?
    fun personalSpaceName(): String
    fun signInRequiredSummary(): String

    interface Owner { val providerEnvironment: ProviderEnvironment }
}
