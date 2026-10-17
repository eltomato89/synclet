package tech.jensk.synclet.provider

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.core.content.MimeTypeFilter
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.ErrorCodes
import tech.jensk.synclet.core.api.NameRules
import tech.jensk.synclet.core.api.OnConflict
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.api.recent
import tech.jensk.synclet.core.api.search
import tech.jensk.synclet.core.api.sha256Hex
import tech.jensk.synclet.core.api.shortKey
import tech.jensk.synclet.core.layout.DocumentIds
import tech.jensk.synclet.core.layout.SpaceLayout
import tech.jensk.synclet.core.upload.dropReplacesOf
import tech.jensk.synclet.core.upload.UploadNotifications
import tech.jensk.synclet.ui.components.nameProblemMessage
import tech.jensk.synclet.ui.components.syncErrorMessage

/**
 * Synclet in the system file picker and the Files app (Spec §2.7). One root per account; document ids
 * `<accountKey>/<syncId>`, virtual top level `<accountKey>/top`. All methods run on binder threads, so blocking
 * network calls are allowed; they honour the CancellationSignal. Never touch the environment in onCreate:
 * providers are created before Application.onCreate.
 *
 * Writes go to a working copy in `cacheDir/provider-work` (never `filesDir/uploads`, whose unknown files the upload
 * queue prunes); on close a changed copy is handed to the upload queue as a `replace` with the etag seen at open.
 * Until that upload is done, reads serve the queued copy (read-after-write returns the new content).
 *
 * Limitation: a client that calls `ParcelFileDescriptor.detachFd()` on a writable descriptor reports "detached"
 * through the close channel, which the listener sees as an error – its edit is dropped like a crashed writer's
 * (with an "upload failed" notification), because the provider can no longer tell when the content is final.
 */
class SyncletDocumentsProvider : NullSafeSearchDocumentsProvider() {
    internal var environmentOverride: ProviderEnvironment? = null
    private val env: ProviderEnvironment
        get() = environmentOverride ?: (ctx.applicationContext as ProviderEnvironment.Owner).providerEnvironment
    /** `requireContext()` is API 30; minSdk is 29. */
    private val ctx: Context
        get() = context ?: throw IllegalStateException("provider not attached")
    /** Opens a writer's working copy; tests replace it to report a crashed writer through the close listener. */
    internal var openWritable: (File, Int, Handler, ParcelFileDescriptor.OnCloseListener) -> ParcelFileDescriptor =
        { file, mode, handler, listener -> ParcelFileDescriptor.open(file, mode, handler, listener) }
    private val loader = Executors.newFixedThreadPool(3)
    private val loading: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val closeHandler: Handler by lazy { Handler(HandlerThread("synclet-documents-close").apply { start() }.looper) }
    private val writes = OpenWrites()
    private val workDirSwept = AtomicBoolean(false)

    override fun onCreate(): Boolean = true

    // ---------------------------------------------------------------- roots and listings

    override fun queryRoots(projection: Array<out String>?): Cursor {
        ready()
        val cursor = MatrixCursor(projection ?: ROOT_PROJECTION)
        for (account in env.accounts()) {
            val row = cursor.newRow()
            row.add(Root.COLUMN_ROOT_ID, account.key)
            row.add(Root.COLUMN_DOCUMENT_ID, DocumentIds.top(account.key))
            row.add(Root.COLUMN_TITLE, ctx.getString(R.string.app_name))
            row.add(Root.COLUMN_SUMMARY, if (account.needsSignIn) "${account.title} · ${env.signInRequiredSummary()}" else account.title)
            row.add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_SEARCH or
                Root.FLAG_SUPPORTS_RECENTS or Root.FLAG_SUPPORTS_IS_CHILD)
            row.add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            if (account.quotaBytes > 0) row.add(Root.COLUMN_AVAILABLE_BYTES, (account.quotaBytes - account.usedBytes).coerceAtLeast(0))
        }
        cursor.setNotificationUri(ctx.contentResolver, DocumentsContract.buildRootsUri(ProviderContract.AUTHORITY))
        return cursor
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        ready()
        val ref = parse(documentId)
        val session = session(ref.accountKey)
        val layout = session.layout
        val cursor = MatrixCursor(projection ?: DOCUMENT_PROJECTION)
        val space = layout.spaceForRootId(ref.syncId)
        when {
            ref.isTop -> addTop(cursor, ref.accountKey)
            space != null -> addSpace(cursor, ref.accountKey, space, layout)
            else -> addItem(cursor, ref.accountKey, layout, item(ref, null))
        }
        return cursor
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        ready()
        val ref = parse(parentDocumentId)
        val session = session(ref.accountKey)
        val layout = session.layout
        val cursor = MatrixCursor(projection ?: DOCUMENT_PROJECTION)
        cursor.setNotificationUri(ctx.contentResolver,
            DocumentsContract.buildChildDocumentsUri(ProviderContract.AUTHORITY, parentDocumentId))
        if (ref.isTop) {
            layout.spaces.forEach { addSpace(cursor, ref.accountKey, it, layout) }
            return cursor
        }
        val cache = env.listingCache
        val listing = cache.get(ref.accountKey, ref.syncId)?.takeIf { it.complete || it.error != null }
        listing?.items?.forEach { addItem(cursor, ref.accountKey, layout, it) }
        val extras = Bundle()
        if (listing != null && cache.isFresh(listing, FRESH_MS)) {
            // Fresh data – or a fresh failure: report it and do not start another load for 30 s (no reload loop).
            listing.error?.let { extras.putString(DocumentsContract.EXTRA_ERROR, it) }
        } else {
            extras.putBoolean(DocumentsContract.EXTRA_LOADING, true)
            loadChildren(ref)
        }
        cursor.extras = extras
        return cursor
    }

    private fun loadChildren(ref: DocumentIds.Parsed) {
        val key = DocumentIds.of(ref.accountKey, ref.syncId)
        if (!loading.add(key)) return
        loader.execute {
            try {
                val session = env.session(ref.accountKey) ?: return@execute
                val items = runBlocking(Dispatchers.IO) { session.api.allChildren(ref.syncId) }
                env.listingCache.put(ref.accountKey, ref.syncId, items)
            } catch (e: Exception) {
                // Recorded with a timestamp: the next query shows EXTRA_ERROR and does not reload for 30 s.
                env.listingCache.putError(ref.accountKey, ref.syncId, ctx.syncErrorMessage(e))
            } finally {
                loading.remove(key)
                env.notifier.childrenChanged(ref.accountKey, ref.syncId)
            }
        }
    }

    override fun querySearchDocuments(rootId: String, query: String, projection: Array<out String>?): Cursor =
        serverList(rootId, projection) { it.api.search(query, limit = 50).hits.map { hit -> hit.item } }

    /**
     * Android 10+ DocumentsUI searches through the Bundle variant (via [NullSafeSearchDocumentsProvider]). The term is QUERY_ARG_DISPLAY_NAME, else the URI's
     * `query` parameter if a caller copied it into the arguments (callers of the old URI-only API still reach the
     * String variant above). QUERY_ARG_MIME_TYPES is applied here: the server search knows no MIME filter.
     */
    override fun searchDocuments(rootId: String, projection: Array<out String>?, queryArgs: Bundle?): Cursor {
        val term = (queryArgs?.getString(DocumentsContract.QUERY_ARG_DISPLAY_NAME) ?: queryArgs?.getString(URI_QUERY_PARAM))
            ?.trim()?.takeIf { it.isNotEmpty() }
        if (term == null) {
            ready()
            session(rootId)
            return MatrixCursor(projection ?: DOCUMENT_PROJECTION)
        }
        val mimeTypes = queryArgs?.getStringArray(DocumentsContract.QUERY_ARG_MIME_TYPES)?.takeIf { it.isNotEmpty() }
        return serverList(rootId, projection, accept = { mimeTypes == null || MimeTypeFilter.matches(mimeOf(it), mimeTypes) != null }) {
            it.api.search(term, limit = 50).hits.map { hit -> hit.item }
        }
    }

    override fun queryRecentDocuments(rootId: String, projection: Array<out String>?): Cursor =
        serverList(rootId, projection) { it.api.recent(limit = 64) }

    private fun serverList(
        accountKey: String, projection: Array<out String>?, accept: (SyncItem) -> Boolean = { true },
        load: suspend (AccountSession) -> List<SyncItem>,
    ): Cursor {
        ready()
        val session = session(accountKey)
        val cursor = MatrixCursor(projection ?: DOCUMENT_PROJECTION)
        try {
            blocking(null, timeoutMs = 10_000) { load(session) }.forEach {
                env.listingCache.putItem(accountKey, it)
                if (accept(it)) addItem(cursor, accountKey, session.layout, it)
            }
        } catch (e: OperationCanceledException) {
            throw e
        } catch (e: Exception) {
            val message = if (e is FileNotFoundException) e.message else ctx.syncErrorMessage(e)
            cursor.extras = Bundle().apply { putString(DocumentsContract.EXTRA_ERROR, message) }
        }
        return cursor
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        ready()
        val parent = DocumentIds.parse(parentDocumentId) ?: return false
        val child = DocumentIds.parse(documentId) ?: return false
        if (parent.accountKey != child.accountKey || parent == child || child.isTop) return false
        if (parent.isTop) return env.session(child.accountKey) != null
        return try { parent.syncId in ancestors(child) } catch (e: Exception) { false }
    }

    override fun findDocumentPath(parentDocumentId: String?, childDocumentId: String): DocumentsContract.Path {
        ready()
        val child = parse(childDocumentId)
        val chain = if (child.isTop) emptyList() else (listOf(child.syncId) + ancestors(child)).reversed()
        val ids = (listOf(DocumentIds.TOP) + chain).map { DocumentIds.of(child.accountKey, it) }
        if (parentDocumentId == null) return DocumentsContract.Path(child.accountKey, ids)
        val start = ids.indexOf(parentDocumentId)
        if (start < 0) throw FileNotFoundException(childDocumentId)
        return DocumentsContract.Path(null, ids.drop(start))
    }

    /**
     * Parent ids from the immediate parent up to the space root (via ListingCache, else GET /items/:id).
     * Stops at the space root: nothing above it is visible in the provider, so it is never fetched.
     */
    private fun ancestors(ref: DocumentIds.Parsed): List<String> {
        val layout = session(ref.accountKey).layout
        if (layout.isSpaceRoot(ref.syncId)) return emptyList()
        val result = ArrayList<String>()
        var current = item(ref, null)
        repeat(MAX_DEPTH) {
            val parentId = current.parentId ?: return result
            result += parentId
            if (layout.isSpaceRoot(parentId)) return result
            current = item(DocumentIds.Parsed(ref.accountKey, parentId), null)
        }
        return result
    }

    // ---------------------------------------------------------------- content

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        ready()
        val ref = parse(documentId)
        if (ref.isTop) throw FileNotFoundException(documentId)
        val session = session(ref.accountKey)
        val accessMode = ParcelFileDescriptor.parseMode(mode)
        val writing = mode.contains('w')
        // Fresh metadata: the etag at open time is the base of a later replace.
        val item = try {
            blocking(signal) { session.api.item(ref.syncId) }.also { env.listingCache.putItem(ref.accountKey, it) }
        } catch (e: OperationCanceledException) {
            throw e
        } catch (e: SyncError.Transport) {
            if (writing) throw notFound(e)
            env.listingCache.item(ref.accountKey, ref.syncId) ?: throw notFound(e)
        } catch (e: FileNotFoundException) {
            throw e
        } catch (e: Exception) {
            throw notFound(e)
        }
        if (item.isFolder) throw FileNotFoundException(ctx.getString(R.string.provider_error_folder))
        if (writing && !item.capabilities.write) throw FileNotFoundException(forbidden())

        // A writer that just closed may still be handing its copy to the queue: wait for it, so this open sees it.
        val writeKey = DocumentIds.of(ref.accountKey, item.id)
        writes.awaitIdle(writeKey, HAND_OVER_WAIT_MS, signal)
        val pending = blocking(null) { env.uploadQueue.pendingReplace(ref.accountKey, item.id) }
        val pendingCopy = pending?.let { env.uploadQueue.copyFile(it.id) }?.takeIf { it.exists() }

        if (!writing) {
            // A local change that is not uploaded yet is the current content.
            val file = pendingCopy ?: readable(session, ref.accountKey, item, signal)
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }

        val work = File(workDir(ref.accountKey), UUID.randomUUID().toString())
        // "w" truncates like "wt" (as ParcelFileDescriptor.parseMode does on devices); "rw" and "wa" start from the content.
        val truncate = accessMode and ParcelFileDescriptor.MODE_TRUNCATE != 0 || mode == "w"
        val baseSha = try {
            if (truncate) { work.createNewFile(); null }
            else { (pendingCopy ?: readable(session, ref.accountKey, item, signal)).copyTo(work, overwrite = true); sha256Hex(work) }
        } catch (e: IOException) {
            work.delete()
            throw if (e is FileNotFoundException) e else FileNotFoundException(e.message)
        }
        val accountKey = ref.accountKey
        val ifMatch = item.contentEtag ?: item.etag
        val parentId = item.parentId ?: SyncItem.ROOT_ID
        // A file directly in a space root: its parent is the space (the root item itself is never listed).
        val parentName = session.layout.spaceForRootId(parentId)?.let { session.layout.displayName(it, env.personalSpaceName()) }
            ?: env.listingCache.item(accountKey, parentId)?.name ?: ""
        val appContext = ctx.applicationContext
        writes.begin(writeKey)
        try {
            return openWritable(work, accessMode, closeHandler) { error ->
                try {
                    when {
                        error != null -> {
                            // The other app crashed (or detached the descriptor): never upload half a file, but say so.
                            work.delete()
                            runCatching { UploadNotifications.failed(appContext, item.name) }
                        }
                        env.session(accountKey) == null -> work.delete()                 // signed out meanwhile
                        baseSha != null && sha256Hex(work) == baseSha -> work.delete()   // opened rw, nothing changed
                        else -> {
                            runBlocking {
                                env.uploadQueue.enqueueReplace(accountKey, item.id, parentId, parentName, item.name,
                                    ifMatch, work, chainAfter = pending?.id)
                            }
                            env.scheduleUploads(accountKey)
                            env.notifier.documentChanged(accountKey, item.id)
                            // DocumentsUI shows the new size/mtime once the parent listing is reloaded.
                            changed(accountKey, parentId)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "could not queue the changed document", e)
                    work.delete()
                    // Never lose an edit silently.
                    runCatching { UploadNotifications.failed(appContext, item.name) }
                } finally {
                    writes.end(writeKey)
                }
            }
        } catch (e: IOException) {
            writes.end(writeKey)
            work.delete()
            throw if (e is FileNotFoundException) e else FileNotFoundException(e.message)
        }
    }

    private fun readable(session: AccountSession, accountKey: String, item: SyncItem, signal: CancellationSignal?): File =
        env.fileCache.cached(accountKey, item) ?: try {
            blocking(signal) { env.fileCache.fetch(session.api, accountKey, item) }
        } catch (e: SyncError.Transport) {
            env.fileCache.latestAny(accountKey, item.id) ?: throw notFound(e)
        } catch (e: OperationCanceledException) {
            throw e
        } catch (e: FileNotFoundException) {
            throw e
        } catch (e: Exception) {
            throw notFound(e)
        }

    /**
     * Working copies of open writers, one directory per account (sign-out clears it, [clearWorkCopies]); leftovers of
     * a killed process (older than a day) are removed once.
     */
    private fun workDir(accountKey: String): File {
        val root = File(ctx.cacheDir, WORK_DIR)
        if (workDirSwept.compareAndSet(false, true)) {
            val cutoff = System.currentTimeMillis() - 24 * 3_600_000L
            root.walkBottomUp().filter { it != root && it.lastModified() < cutoff && (it.isFile || it.list().isNullOrEmpty()) }
                .forEach { it.delete() }
        }
        return File(root, shortKey(accountKey)).apply { mkdirs() }
    }

    override fun openDocumentThumbnail(documentId: String, sizeHint: Point?, signal: CancellationSignal?): AssetFileDescriptor {
        ready()
        val ref = parse(documentId)
        val item = item(ref, signal)
        if (item.isFolder || !item.hasThumbnail) throw FileNotFoundException(documentId)
        val file = blocking(signal) { env.thumbnailFile(ref.accountKey, item, 256) } ?: throw FileNotFoundException(documentId)
        return AssetFileDescriptor(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    }

    // ---------------------------------------------------------------- structure

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
        ready()
        val parent = parse(parentDocumentId)
        if (parent.isTop) throw UnsupportedOperationException(ctx.getString(R.string.provider_error_top))
        val name = if (mimeType == Document.MIME_TYPE_DIR) displayName.trim() else withExtension(displayName.trim(), mimeType)
        NameRules.check(name)?.let { throw IllegalArgumentException(ctx.nameProblemMessage(it)) }
        val session = session(parent.accountKey)
        val folder = item(parent, null)
        if (!session.layout.canCreateIn(folder)) throw UnsupportedOperationException(forbidden())
        val created = mutate(parent.accountKey, null, folder.id) {
            if (mimeType == Document.MIME_TYPE_DIR) session.api.createFolder(folder.id, name, OnConflict.RENAME)
            else {
                // A new file gets its id right away; the app's writes then arrive as `replace` (Spec §2.7).
                val empty = File.createTempFile("new", null, ctx.cacheDir)
                try { session.api.uploadNew(folder.id, name, empty, OnConflict.RENAME) } finally { empty.delete() }
            }
        }
        env.listingCache.putItem(parent.accountKey, created)
        changed(parent.accountKey, folder.id)
        return DocumentIds.of(parent.accountKey, created.id)
    }

    override fun renameDocument(documentId: String, displayName: String): String? {
        ready()
        val ref = parse(documentId)
        val name = displayName.trim()
        NameRules.check(name)?.let { throw IllegalArgumentException(ctx.nameProblemMessage(it)) }
        val session = session(ref.accountKey)
        val item = item(ref, null)
        if (!item.capabilities.rename) throw UnsupportedOperationException(forbidden())
        val updated = mutate(ref.accountKey, item.id, item.parentId) { session.api.patchItem(item.id, name = name, ifMatch = item.etag) }
        env.listingCache.putItem(ref.accountKey, updated)
        updated.parentId?.let { changed(ref.accountKey, it) }
        env.notifier.documentChanged(ref.accountKey, item.id)
        return null        // ids are stable
    }

    override fun moveDocument(sourceDocumentId: String, sourceParentDocumentId: String, targetParentDocumentId: String): String {
        ready()
        val source = parse(sourceDocumentId)
        val target = parse(targetParentDocumentId)
        if (source.accountKey != target.accountKey) throw UnsupportedOperationException(ctx.getString(R.string.provider_error_cross_account))
        if (target.isTop || source.isTop) throw UnsupportedOperationException(ctx.getString(R.string.provider_error_top))
        val session = session(source.accountKey)
        val item = item(source, null)
        val folder = item(target, null)
        if (!item.capabilities.move || !session.layout.canCreateIn(folder)) throw UnsupportedOperationException(forbidden())
        val updated = mutate(source.accountKey, item.id, item.parentId) { session.api.patchItem(item.id, parentId = folder.id, ifMatch = item.etag) }
        env.listingCache.putItem(source.accountKey, updated)
        item.parentId?.let { changed(source.accountKey, it) }
        changed(source.accountKey, folder.id)
        return sourceDocumentId
    }

    override fun deleteDocument(documentId: String) {
        ready()
        val ref = parse(documentId)
        if (ref.isTop) throw UnsupportedOperationException(ctx.getString(R.string.provider_error_top))
        val session = session(ref.accountKey)
        val item = item(ref, null)
        if (!item.capabilities.delete) throw UnsupportedOperationException(forbidden())
        val alreadyGone = try {
            mutate(ref.accountKey, item.id, item.parentId) { session.api.deleteItem(item.id, ifMatch = item.etag) }
            false
        } catch (e: FileNotFoundException) {
            true                                   // mutate already invalidated and notified the parent
        }
        env.listingCache.removeItem(ref.accountKey, item.id)
        env.fileCache.evict(ref.accountKey, item.id)
        dropPendingReplaces(session, ref.accountKey, item.id)
        if (!alreadyGone) item.parentId?.let { changed(ref.accountKey, it) }
    }

    /**
     * An explicitly deleted file must not come back: queued replaces of it would hit 404 and be re-uploaded as a new
     * file (Spec-Klärung 9). Shared with the app's delete (UploadQueue.dropReplacesOf): waiting and running replaces
     * go (their tus upload is terminated, best effort); conflict copies stay, they hold the user's edit as a new file.
     */
    private fun dropPendingReplaces(session: AccountSession, accountKey: String, itemId: String) {
        try {
            blocking(null) { env.uploadQueue.dropReplacesOf(session.api, accountKey, itemId) }
        } catch (e: Exception) {
            Log.w(TAG, "could not drop a queued replace of a deleted file", e)
        }
    }

    override fun removeDocument(documentId: String, parentDocumentId: String) = deleteDocument(documentId)

    // ---------------------------------------------------------------- helpers

    /** AppGraph publishes accounts before their sessions exist: everything waits for the ready gate. */
    private fun ready() = blocking(null) { env.awaitReady() }

    private fun parse(documentId: String): DocumentIds.Parsed =
        DocumentIds.parse(documentId) ?: throw FileNotFoundException(documentId)

    private fun session(accountKey: String): AccountSession =
        env.session(accountKey) ?: throw FileNotFoundException(ctx.getString(R.string.provider_error_no_account))

    /** The item from the listing cache, else from the server (and cached). */
    private fun item(ref: DocumentIds.Parsed, signal: CancellationSignal?): SyncItem {
        env.listingCache.item(ref.accountKey, ref.syncId)?.let { return it }
        val session = session(ref.accountKey)
        return try {
            blocking(signal) { session.api.item(ref.syncId) }.also { env.listingCache.putItem(ref.accountKey, it) }
        } catch (e: OperationCanceledException) {
            throw e
        } catch (e: FileNotFoundException) {
            throw e
        } catch (e: Exception) {
            throw notFound(e)
        }
    }

    /**
     * Runs a mutation; maps errors to exceptions DocumentsUI can show. 412/404 also invalidate the parent listing and
     * refresh the item index (412: the server's current item, so a retry sends the new etag; 404: forget the item).
     */
    private fun <T> mutate(accountKey: String, itemId: String?, parentId: String?, block: suspend () -> T): T = try {
        blocking(null) { block() }
    } catch (e: SyncError.Http) {
        if (e.status == 412) e.item?.let { env.listingCache.putItem(accountKey, it) } ?: itemId?.let { env.listingCache.removeItem(accountKey, it) }
        if (e.status == 404) itemId?.let { env.listingCache.removeItem(accountKey, it) }
        if (e.status == 412 || e.status == 404) parentId?.let { changed(accountKey, it) }
        throw if (e.status == 404) FileNotFoundException(ctx.syncErrorMessage(e))
              else IllegalStateException(ctx.syncErrorMessage(e))
    } catch (e: SyncError) {
        throw IllegalStateException(ctx.syncErrorMessage(e))
    }

    private fun changed(accountKey: String, folderId: String) {
        env.listingCache.invalidate(accountKey, folderId)
        env.notifier.childrenChanged(accountKey, folderId)
    }

    private fun forbidden() = ctx.syncErrorMessage(SyncError.Http(403, ErrorCodes.FORBIDDEN, null))

    private fun notFound(e: Throwable) = FileNotFoundException(ctx.syncErrorMessage(e))

    private fun <T> blocking(signal: CancellationSignal?, timeoutMs: Long? = null, block: suspend () -> T): T {
        try {
            return runBlocking(Dispatchers.IO) {
                val job = coroutineContext[Job]!!
                signal?.setOnCancelListener { job.cancel() }
                if (timeoutMs != null) withTimeout(timeoutMs) { block() } else block()
            }
        } catch (e: TimeoutCancellationException) {
            throw FileNotFoundException(ctx.syncErrorMessage(SyncError.Transport(IOException("timeout"))))
        } catch (e: CancellationException) {
            if (signal?.isCanceled == true) throw OperationCanceledException()
            throw e
        } finally {
            signal?.setOnCancelListener(null)
        }
    }

    private fun withExtension(name: String, mime: String): String {
        if (name.substringAfterLast('.', "").isNotEmpty() || mime == "application/octet-stream") return name
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: return name
        return "$name.$ext"
    }

    private fun addTop(cursor: MatrixCursor, accountKey: String) {
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, DocumentIds.top(accountKey))
            .add(Document.COLUMN_DISPLAY_NAME, env.accounts().firstOrNull { it.key == accountKey }?.title ?: ctx.getString(R.string.app_name))
            .add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
            .add(Document.COLUMN_FLAGS, 0)
    }

    private fun addSpace(cursor: MatrixCursor, accountKey: String, space: SyncSpace, layout: SpaceLayout) {
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, DocumentIds.of(accountKey, space.rootId))
            .add(Document.COLUMN_DISPLAY_NAME, layout.displayName(space, env.personalSpaceName()))
            .add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR)
            .add(Document.COLUMN_FLAGS, if (space.canWrite && !space.isMissing) Document.FLAG_DIR_SUPPORTS_CREATE else 0)
            .add(Document.COLUMN_SUMMARY, if (space.isMissing) ctx.getString(R.string.provider_space_unavailable) else null)
    }

    private fun addItem(cursor: MatrixCursor, accountKey: String, layout: SpaceLayout, item: SyncItem) {
        layout.spaceForRootId(item.id)?.let { addSpace(cursor, accountKey, it, layout); return }
        cursor.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, DocumentIds.of(accountKey, item.id))
            .add(Document.COLUMN_DISPLAY_NAME, item.name)
            .add(Document.COLUMN_MIME_TYPE, mimeOf(item))
            .add(Document.COLUMN_SIZE, if (item.isFolder) null else item.size)
            .add(Document.COLUMN_LAST_MODIFIED, runCatching { Instant.parse(item.modifiedAt).toEpochMilli() }.getOrNull())
            .add(Document.COLUMN_FLAGS, DocumentRows.flags(item, layout))
    }

    private fun mimeOf(item: SyncItem): String = DocumentRows.mime(item) { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }

    /** Writers per document whose close has not been handed to the upload queue yet. */
    private class OpenWrites {
        private val lock = ReentrantLock()
        private val idle = lock.newCondition()
        private val open = HashMap<String, Int>()

        fun begin(key: String) = lock.withLock { open[key] = (open[key] ?: 0) + 1 }

        fun end(key: String) = lock.withLock {
            val n = (open[key] ?: 1) - 1
            if (n <= 0) open.remove(key) else open[key] = n
            idle.signalAll()
        }

        /**
         * Waits until no writer of [key] is open, at most [timeoutMs] (a writer that stays open is not waited for
         * longer). Checks [signal] every few milliseconds: a cancelled open stops waiting at once.
         */
        fun awaitIdle(key: String, timeoutMs: Long, signal: CancellationSignal?) = lock.withLock {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (open.containsKey(key)) {
                if (signal?.isCanceled == true) throw OperationCanceledException()
                val left = deadline - System.nanoTime()
                if (left <= 0) return@withLock
                idle.awaitNanos(minOf(left, TimeUnit.MILLISECONDS.toNanos(CANCEL_POLL_MS)))
            }
        }
    }

    companion object {
        private const val TAG = "SyncletProvider"
        private const val FRESH_MS = 30_000L
        private const val MAX_DEPTH = 64
        private const val HAND_OVER_WAIT_MS = 1_000L
        private const val CANCEL_POLL_MS = 20L
        private const val WORK_DIR = "provider-work"
        /** The `query` parameter of a search URI (DocumentsContract.buildSearchDocumentsUri). */
        private const val URI_QUERY_PARAM = "query"

        /** Sign-out: the account's working copies of open writers go too (their close then uploads nothing). */
        fun clearWorkCopies(context: Context, accountKey: String) {
            File(File(context.cacheDir, WORK_DIR), shortKey(accountKey)).deleteRecursively()
        }
        private val ROOT_PROJECTION = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY,
            Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_AVAILABLE_BYTES)
        private val DOCUMENT_PROJECTION = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS, Document.COLUMN_SUMMARY)
    }
}
