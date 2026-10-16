package tech.jensk.synclet.core.cache

import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.shortKey

/**
 * Opened files: <dir>/<shortKey>/<itemId>/<version>/<name>, LRU by the item directory's mtime, version-bound.
 * Used by the app (preview, "open with", share) and by the provider for reads.
 */
class FileCache(private val dir: File, private val maxBytes: Long = 1L shl 30) {
    private val locks = ConcurrentHashMap<String, Mutex>()

    private fun accountDir(accountKey: String) = File(dir, shortKey(accountKey))
    private fun itemDir(accountKey: String, itemId: String) = File(accountDir(accountKey), itemId)
    private fun versionDir(accountKey: String, item: SyncItem) = File(itemDir(accountKey, item.id), versionKey(item))
    private fun target(accountKey: String, item: SyncItem) = File(versionDir(accountKey, item), safeName(item.name))

    fun cached(accountKey: String, item: SyncItem): File? =
        target(accountKey, item).takeIf { it.isFile }?.also { itemDir(accountKey, item.id).setLastModified(System.currentTimeMillis()) }

    suspend fun fetch(api: SyncApi, accountKey: String, item: SyncItem, onProgress: (Long, Long?) -> Unit = { _, _ -> }): File {
        cached(accountKey, item)?.let { return it }
        val lockKey = "${shortKey(accountKey)}/${item.id}/${versionKey(item)}"
        return locks.getOrPut(lockKey) { Mutex() }.withLock {
            cached(accountKey, item)?.let { return@withLock it }
            val versionDir = versionDir(accountKey, item)
            withContext(Dispatchers.IO) { versionDir.mkdirs() }
            val partial = File(versionDir, ".partial")
            val length = api.download(item.id, partial, ifRange = item.contentEtag, onProgress = onProgress)
            val stored = withContext(Dispatchers.IO) { partial.length() }
            if (length != item.size || stored != item.size) {
                // Short or overlong body: never serve it as this version (and never resume from it).
                withContext(Dispatchers.IO) { partial.delete() }
                throw SyncError.InvalidResponse("download of ${item.id}: $stored bytes instead of ${item.size}")
            }
            withContext(Dispatchers.IO) {
                val file = target(accountKey, item)
                if (!partial.renameTo(file)) throw IOException("cannot store ${item.name} in the cache")
                itemDir(accountKey, item.id).listFiles()?.filter { it.name != versionDir.name }?.forEach { it.deleteRecursively() }
                itemDir(accountKey, item.id).setLastModified(System.currentTimeMillis())
                evict(keep = itemDir(accountKey, item.id))
                file
            }
        }
    }

    /** Newest cached version of the item, whatever its version (offline fallback). */
    fun latestAny(accountKey: String, itemId: String): File? =
        itemDir(accountKey, itemId).listFiles()?.filter { it.isDirectory }?.maxByOrNull { it.lastModified() }
            ?.listFiles()?.firstOrNull { it.isFile && !it.name.startsWith(".") }

    fun evict(accountKey: String, itemId: String) { itemDir(accountKey, itemId).deleteRecursively() }

    suspend fun clearAccount(accountKey: String) = withContext(Dispatchers.IO) { accountDir(accountKey).deleteRecursively(); Unit }

    suspend fun clear() = withContext(Dispatchers.IO) { dir.listFiles()?.forEach { it.deleteRecursively() }; Unit }

    fun sizeBytes(): Long = dir.walkBottomUp().filter { it.isFile }.sumOf { it.length() }

    private fun evict(keep: File) {
        val entries = dir.listFiles()?.flatMap { account -> account.listFiles()?.toList() ?: emptyList() } ?: return
        var total = entries.sumOf { size(it) }
        for (entry in entries.sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            if (entry == keep) continue
            total -= size(entry)
            entry.deleteRecursively()
        }
    }

    private fun size(entry: File): Long = entry.walkBottomUp().filter { it.isFile }.sumOf { it.length() }

    companion object {
        fun versionKey(item: SyncItem): String = item.contentEtag ?: item.version?.let { "v$it" } ?: item.etag
        private fun safeName(name: String): String = name.replace('/', '_').replace('\u0000', '_').ifEmpty { "file" }
    }
}
