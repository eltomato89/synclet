package tech.jensk.synclet

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import coil3.ImageLoader
import java.io.File
import java.io.FileNotFoundException
import java.time.ZonedDateTime
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountRepository
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AccountStore
import tech.jensk.synclet.core.account.AppSettings
import tech.jensk.synclet.core.account.TokenVault
import tech.jensk.synclet.core.api.SyncHttp
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.DeviceRegistrar
import tech.jensk.synclet.core.cache.FileCache
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.cache.ThumbnailCache
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.core.upload.UploadEntry
import tech.jensk.synclet.core.upload.UploadEnvironment
import tech.jensk.synclet.core.upload.UploadFailure
import tech.jensk.synclet.core.upload.UploadNames
import tech.jensk.synclet.core.upload.UploadQueue
import tech.jensk.synclet.core.upload.UploadScheduler
import tech.jensk.synclet.core.upload.Uploader
import tech.jensk.synclet.provider.ContentResolverNotifier
import tech.jensk.synclet.provider.ProviderEnvironment
import tech.jensk.synclet.provider.ProviderNotifier
import tech.jensk.synclet.sync.ForegroundSync
import tech.jensk.synclet.core.R as CoreR

/**
 * One per process (SyncletApp.graph, lazy – the provider may need it before Application.onCreate).
 * The shared [http] client keeps OkHttp's default redirect handling, which drops `Authorization` on a
 * cross-host redirect; SyncApi additionally refuses to sign requests for any other origin.
 */
class AppGraph(private val app: Application) : UploadEnvironment, ProviderEnvironment {
    val appVersion: String = BuildConfig.VERSION_NAME
    val http: OkHttpClient = SyncHttp.client(appVersion)
    /** EventStream sets its own idle read timeout on top of this client. */
    val sseHttp: OkHttpClient = SyncHttp.sseClient(http)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val accountStore = AccountStore(File(app.filesDir, "accounts.json"))
    val tokenVault = TokenVault.create(app)
    val settings = AppSettings.create(app)
    override val uploadQueue = UploadQueue(File(app.filesDir, "uploads"))
    override val fileCache = FileCache(File(app.cacheDir, "files"))
    override val listingCache = ListingCache()
    val imageLoader: ImageLoader = ThumbnailCache.newImageLoader(app, http, File(app.cacheDir, "thumbnails"))
    override val notifier: ProviderNotifier = ContentResolverNotifier(app.contentResolver)
    override val deviceName: String = DeviceInfo.name(app)

    val accounts = AccountRepository(
        store = accountStore, vault = tokenVault, http = http, browserLogin = BrowserLogin(http),
        registrar = DeviceRegistrar(http), deviceName = deviceName,
        installationId = DeviceRegistrar.installationId(DeviceInfo.androidId(app)), appVersion = appVersion, scope = scope,
        onAccountsChanged = { notifier.rootsChanged() },
        onSignedIn = { key -> resumeAfterSignIn(key) },
        onSignedOut = { key -> forgetAccount(key) },
    )
    val foregroundSync = ForegroundSync(scope, accounts, sseHttp, listingCache, notifier)
    val folderChanges: SharedFlow<FolderChange> get() = foregroundSync.changes
    val selectedAccountKey: StateFlow<String?> = combine(settings.selectedAccount, accounts.accounts) { selected, list ->
        list.firstOrNull { it.key == selected }?.key ?: list.firstOrNull()?.key
    }.stateIn(scope, SharingStarted.Eagerly, null)

    private val ready = CompletableDeferred<Unit>()

    init {
        scope.launch {
            try {
                accounts.load()
                uploadQueue.load()
                uploadQueue.prune()          // finished entries leave the list after 24 h even without new uploads
                ready.complete(Unit)
                accounts.accounts.value.forEach { if (uploadQueue.hasWork(it.key)) UploadScheduler.schedule(app, it.key) }
            } catch (e: Throwable) {
                ready.completeExceptionally(e)
            }
        }
        scope.launch { accounts.accounts.collect { foregroundSync.onAccountsChanged(it) } }
    }

    override suspend fun awaitReady() = ready.await()
    override fun accounts(): List<Account> = accounts.accounts.value
    override fun session(accountKey: String): AccountSession? = accounts.session(accountKey)
    override fun scheduleUploads(accountKey: String) = UploadScheduler.schedule(app, accountKey)
    override suspend fun thumbnailFile(accountKey: String, item: SyncItem, size: Int): File? =
        session(accountKey)?.let { ThumbnailCache.file(app, imageLoader, it.api, accountKey, item, size) }
    override fun personalSpaceName(): String = app.getString(R.string.space_personal)
    override fun signInRequiredSummary(): String = app.getString(R.string.account_sign_in_required)

    // UploadEnvironment: null only when the account is gone (a signed-out-but-known account fails with SIGNED_OUT).
    override fun uploader(accountKey: String): Uploader? = session(accountKey)?.let {
        Uploader(it.api, uploadQueue, deviceName, app.getString(CoreR.string.upload_conflict_word))
    }

    override fun onUploadFinished(entry: UploadEntry, item: SyncItem) {
        listingCache.putItem(entry.accountKey, item)
        notifier.documentChanged(entry.accountKey, item.id)
        publishLocalChange(FolderChange.Folders(entry.accountKey, setOf(item.parentId ?: entry.parentId)))
    }

    /** A change the app made itself: listings stale, provider notified, open views refreshed. */
    fun publishLocalChange(change: FolderChange) = foregroundSync.publish(change)

    suspend fun enqueueUploads(accountKey: String, parentId: String, parentName: String, uris: List<Uri>): Int {
        var count = 0
        for (uri in uris) {
            val (display, mime) = withContext(Dispatchers.IO) { nameAndType(uri) }
            val name = UploadNames.forShared(display, mime, ZonedDateTime.now(), app.getString(CoreR.string.upload_fallback_name)) {
                MimeTypeMap.getSingleton().getExtensionFromMimeType(it)
            }
            uploadQueue.enqueueCreate(accountKey, parentId, parentName, name, {
                app.contentResolver.openInputStream(uri) ?: throw FileNotFoundException(uri.toString())
            })
            count++
        }
        if (count > 0) UploadScheduler.schedule(app, accountKey)
        return count
    }

    suspend fun enqueueText(accountKey: String, parentId: String, parentName: String, text: String, subject: String?): Int {
        val name = UploadNames.forShared(subject?.let { "$it.txt" }, "text/plain", ZonedDateTime.now(),
            app.getString(R.string.shared_text_name)) { "txt" }
        uploadQueue.enqueueCreate(accountKey, parentId, parentName, name, { text.byteInputStream(Charsets.UTF_8) })
        UploadScheduler.schedule(app, accountKey)
        return 1
    }

    suspend fun clearCaches() {
        fileCache.clear()
        withContext(Dispatchers.IO) {
            imageLoader.diskCache?.clear()
            imageLoader.memoryCache?.clear()
        }
    }

    private fun nameAndType(uri: Uri): Pair<String?, String?> {
        val mime = app.contentResolver.getType(uri)
        val name = runCatching {
            app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment
        return name to mime
    }

    /** After a (re-)sign-in: entries stopped by SIGNED_OUT and entries left waiting resume. */
    private suspend fun resumeAfterSignIn(key: String) {
        uploadQueue.entries.value.filter { it.accountKey == key && it.failure == UploadFailure.SIGNED_OUT }.forEach { uploadQueue.retry(it.id) }
        if (uploadQueue.hasWork(key)) UploadScheduler.schedule(app, key)
    }

    private suspend fun forgetAccount(key: String) {
        UploadScheduler.cancel(app, key)
        uploadQueue.removeAccount(key)
        fileCache.clearAccount(key)
        listingCache.clear(key)
        withContext(Dispatchers.IO) {
            imageLoader.diskCache?.clear()
            imageLoader.memoryCache?.clear()
        }
        if (settings.selectedAccount.first() == key) settings.setSelectedAccount(null)
    }
}
