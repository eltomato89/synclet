package tech.jensk.synclet.core.upload

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson

/**
 * Persistent upload queue (one process: app, provider, share and worker share one instance):
 *   <dir>/queue.json   {"v":1,"entries":[…]}, written atomically under a mutex
 *   <dir>/<id>         private copy of the source; <id>.part while copying
 * A broken or newer file is moved to queue.json.corrupt-<time> and the queue starts empty.
 */
class UploadQueue(private val dir: File, private val clock: () -> Long = System::currentTimeMillis) {
    @Serializable private data class QueueFile(val v: Int = VERSION, val entries: List<UploadEntry> = emptyList())

    private val mutex = Mutex()
    private val file = File(dir, "queue.json")
    private var loaded = false
    private val state = MutableStateFlow<List<UploadEntry>>(emptyList())
    val entries: StateFlow<List<UploadEntry>> = state.asStateFlow()

    fun copyFile(id: String): File = File(dir, id)

    suspend fun load() = mutex.withLock { ensureLoaded() }

    suspend fun entry(id: String): UploadEntry? = mutex.withLock { ensureLoaded(); state.value.firstOrNull { it.id == id } }

    suspend fun enqueueCreate(
        accountKey: String, parentId: String, parentName: String, name: String, source: UploadSource, modifiedAt: String? = null,
    ): UploadEntry {
        load()
        val id = UUID.randomUUID().toString()
        val part = File(dir, "$id.part")
        val size = withContext(Dispatchers.IO) {
            try {
                source.open().use { input -> part.outputStream().use { out -> input.copyTo(out, 64 * 1024) } }
            } catch (e: Throwable) {
                part.delete(); throw e
            }
        }
        // Rename and record under the lock: prune() (same lock) must never see the copy without its entry.
        return mutex.withLock {
            if (!part.renameTo(copyFile(id))) { part.delete(); throw IOException("cannot move the upload copy into place") }
            val entry = UploadEntry(id = id, accountKey = accountKey, parentId = parentId, parentName = parentName,
                name = name, size = size, modifiedAt = modifiedAt, createdAt = clock())
            write(state.value + entry)
            entry
        }
    }

    suspend fun enqueueReplace(
        accountKey: String, itemId: String, parentId: String, parentName: String, name: String,
        ifMatch: String, workingCopy: File, chainAfter: String?,
    ): UploadEntry = mutex.withLock {
        ensureLoaded()
        val waiting = state.value.lastOrNull {
            it.accountKey == accountKey && it.itemId == itemId && it.kind == UploadKind.REPLACE && it.status == UploadStatus.WAITING
        }
        if (waiting != null) {
            // Newest content wins; the base (ifMatch / chainAfter) of the waiting upload stays.
            withContext(Dispatchers.IO) { moveInto(workingCopy, copyFile(waiting.id)) }
            val merged = waiting.copy(name = name, size = copyFile(waiting.id).length(), tusUrl = null, tusOffset = 0, sent = 0)
            write(state.value.map { if (it.id == waiting.id) merged else it })
            return@withLock merged
        }
        val id = UUID.randomUUID().toString()
        withContext(Dispatchers.IO) { moveInto(workingCopy, copyFile(id)) }
        val entry = UploadEntry(id = id, accountKey = accountKey, parentId = parentId, parentName = parentName, name = name,
            size = copyFile(id).length(), kind = UploadKind.REPLACE, itemId = itemId, ifMatch = ifMatch,
            chainAfter = chainAfter, createdAt = clock())
        write(state.value + entry)
        entry
    }

    suspend fun pendingReplace(accountKey: String, itemId: String): UploadEntry? = mutex.withLock {
        ensureLoaded()
        state.value.lastOrNull {
            it.accountKey == accountKey && it.itemId == itemId && it.kind == UploadKind.REPLACE &&
                (it.status == UploadStatus.WAITING || it.status == UploadStatus.UPLOADING)
        }
    }

    /** Oldest waiting or interrupted (still UPLOADING) entry of the account, now UPLOADING. FIFO keeps chains in order. */
    suspend fun claimNext(accountKey: String): UploadEntry? = mutex.withLock {
        ensureLoaded()
        val next = state.value
            .filter { it.accountKey == accountKey && (it.status == UploadStatus.WAITING || it.status == UploadStatus.UPLOADING) }
            .minByOrNull { it.createdAt } ?: return@withLock null
        val claimed = next.copy(status = UploadStatus.UPLOADING)
        write(state.value.map { if (it.id == next.id) claimed else it })
        claimed
    }

    suspend fun update(id: String, transform: (UploadEntry) -> UploadEntry): UploadEntry? = mutex.withLock {
        ensureLoaded()
        val old = state.value.firstOrNull { it.id == id } ?: return@withLock null
        val new = transform(old)
        write(state.value.map { if (it.id == id) new else it })
        new
    }

    suspend fun markDone(id: String, item: SyncItem, conflictCopyName: String?) {
        update(id) {
            it.copy(status = UploadStatus.DONE, failure = null, message = null, tusUrl = null, sent = it.size,
                resultItemId = item.id, resultEtag = item.contentEtag ?: item.etag,
                conflictCopyName = conflictCopyName, finishedAt = clock())
        } ?: return
        withContext(Dispatchers.IO) { copyFile(id).delete() }
    }

    suspend fun markFailed(id: String, failure: UploadFailure, message: String?) {
        update(id) { it.copy(status = UploadStatus.FAILED, failure = failure, message = message, finishedAt = clock()) }
    }

    /** Transient failure: back to WAITING; returns the attempts so far. */
    suspend fun markRetry(id: String, message: String?): Int =
        update(id) { it.copy(status = UploadStatus.WAITING, attempts = it.attempts + 1, message = message) }?.attempts ?: 0

    suspend fun retry(id: String) {
        update(id) { it.copy(status = UploadStatus.WAITING, attempts = 0, failure = null, message = null, finishedAt = null) }
    }

    suspend fun remove(id: String): UploadEntry? = mutex.withLock {
        ensureLoaded()
        val removed = state.value.firstOrNull { it.id == id } ?: return@withLock null
        write(state.value.filterNot { it.id == id })
        withContext(Dispatchers.IO) { copyFile(id).delete() }
        removed
    }

    suspend fun removeAccount(accountKey: String) = mutex.withLock {
        ensureLoaded()
        val (gone, kept) = state.value.partition { it.accountKey == accountKey }
        write(kept)
        withContext(Dispatchers.IO) { gone.forEach { copyFile(it.id).delete() } }
    }

    suspend fun prune() = mutex.withLock {
        ensureLoaded()
        val cutoff = clock() - DONE_RETENTION_MS
        val kept = state.value.filterNot { it.status == UploadStatus.DONE && (it.finishedAt ?: 0) < cutoff }
        if (kept.size != state.value.size) write(kept)
        val ids = kept.map { it.id }.toSet()
        withContext(Dispatchers.IO) {
            dir.listFiles()?.forEach { f ->
                val name = f.name
                val keep = name.startsWith("queue.json") || name in ids ||
                    (name.endsWith(".part") && f.lastModified() > clock() - DONE_RETENTION_MS)
                if (!keep) f.delete()
            }
        }
    }

    suspend fun hasWork(accountKey: String): Boolean = mutex.withLock {
        ensureLoaded()
        state.value.any { it.accountKey == accountKey && (it.status == UploadStatus.WAITING || it.status == UploadStatus.UPLOADING) }
    }

    private suspend fun ensureLoaded() {
        if (loaded) return
        state.value = withContext(Dispatchers.IO) { dir.mkdirs(); read() }
        loaded = true
    }

    private fun read(): List<UploadEntry> {
        if (!file.exists()) return emptyList()
        return try {
            val parsed = SyncJson.decodeFromString(QueueFile.serializer(), file.readText())
            if (parsed.v == VERSION) parsed.entries else { moveAside(); emptyList() }
        } catch (e: Exception) {
            moveAside(); emptyList()
        }
    }

    private fun moveAside() { file.renameTo(File(dir, "queue.json.corrupt-${clock()}")) }

    private suspend fun write(entries: List<UploadEntry>) {
        withContext(Dispatchers.IO) {
            val tmp = File(dir, "queue.json.tmp")
            tmp.writeText(SyncJson.encodeToString(QueueFile.serializer(), QueueFile(VERSION, entries)))
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
        state.value = entries
    }

    private fun moveInto(source: File, target: File) {
        if (!source.renameTo(target)) { source.copyTo(target, overwrite = true); source.delete() }
    }

    private companion object {
        const val VERSION = 1
        const val DONE_RETENTION_MS = 24 * 3_600_000L
    }
}
