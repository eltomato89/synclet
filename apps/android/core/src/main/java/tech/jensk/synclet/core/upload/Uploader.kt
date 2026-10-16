package tech.jensk.synclet.core.upload

import java.io.File
import java.time.ZonedDateTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import tech.jensk.synclet.core.api.ErrorCodes
import tech.jensk.synclet.core.api.OnConflict
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem

sealed interface UploadOutcome {
    data class Done(val item: SyncItem, val conflictCopyName: String?) : UploadOutcome
    data class Failed(val failure: UploadFailure, val message: String?) : UploadOutcome
    data class Retry(val message: String?) : UploadOutcome
    data object Removed : UploadOutcome
}

/** Transfers one queue entry (SYNC_API §6.3, §6.4, §7). Progress and tus state are persisted in the queue. */
class Uploader(
    private val api: SyncApi,
    private val queue: UploadQueue,
    private val deviceName: String,
    private val conflictWord: String,
    private val chunkSize: Long = 16L shl 20,
    private val threshold: Long = 32L shl 20,
    private val now: () -> ZonedDateTime = ZonedDateTime::now,
) {
    private val tus = TusClient(api)
    private class RemovedSignal : Exception()

    suspend fun upload(entry: UploadEntry, onProgress: (Long) -> Unit = {}): UploadOutcome {
        val copy = queue.copyFile(entry.id)
        if (!copy.exists()) return UploadOutcome.Failed(UploadFailure.SOURCE_MISSING, null)
        return try {
            when (entry.kind) {
                UploadKind.CREATE -> UploadOutcome.Done(create(entry, copy, entry.name, entry.parentId, onProgress), null)
                UploadKind.REPLACE -> replace(entry, copy, onProgress)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: RemovedSignal) {
            UploadOutcome.Removed
        } catch (e: SyncError) {
            map(e)
        }
    }

    private suspend fun create(entry: UploadEntry, copy: File, name: String, parentId: String, onProgress: (Long) -> Unit): SyncItem =
        if (copy.length() <= threshold) api.uploadNew(parentId, name, copy, OnConflict.RENAME, entry.modifiedAt, onProgress)
        else tus(entry, copy, TusTarget.Create(name, parentId), onProgress, restarted = false)

    private suspend fun replace(entry: UploadEntry, copy: File, onProgress: (Long) -> Unit): UploadOutcome {
        val itemId = entry.itemId ?: return UploadOutcome.Failed(UploadFailure.OTHER, "replace without item")
        val ifMatch = resolveIfMatch(entry) ?: return UploadOutcome.Retry("waiting for the previous upload of this file")
        return try {
            val item = if (copy.length() <= threshold) api.replaceContent(itemId, copy, ifMatch, entry.modifiedAt, onProgress)
                       else tus(entry, copy, TusTarget.Replace(itemId, ifMatch), onProgress, restarted = false)
            UploadOutcome.Done(item, null)
        } catch (e: SyncError.Http) {
            when {
                // Changed on the server meanwhile: keep our content as a conflict copy next to it (§6.3).
                e.status == 412 && e.code == ErrorCodes.CONFLICT -> {
                    val copyName = ConflictNaming.name(entry.name, deviceName, conflictWord, now())
                    val fresh = queue.update(entry.id) { it.copy(tusUrl = null, tusOffset = 0, sent = 0) } ?: throw RemovedSignal()
                    UploadOutcome.Done(create(fresh, copy, copyName, e.item?.parentId ?: entry.parentId, onProgress), copyName)
                }
                // The file was deleted meanwhile: the content is not lost, it comes back as a new file (Spec-Klärung 9).
                e.status == 404 && e.code == ErrorCodes.NOT_FOUND -> {
                    val fresh = queue.update(entry.id) { it.copy(tusUrl = null, tusOffset = 0, sent = 0) } ?: throw RemovedSignal()
                    UploadOutcome.Done(create(fresh, copy, entry.name, entry.parentId, onProgress), null)
                }
                else -> throw e
            }
        }
    }

    /** A replace chained after an earlier upload of the same file is based on that upload's result. */
    private suspend fun resolveIfMatch(entry: UploadEntry): String? {
        val previousId = entry.chainAfter ?: return entry.ifMatch
        val previous = queue.entry(previousId) ?: return entry.ifMatch
        return when (previous.status) {
            UploadStatus.DONE ->
                if (previous.conflictCopyName == null && previous.resultItemId == entry.itemId) previous.resultEtag ?: entry.ifMatch
                else entry.ifMatch
            UploadStatus.FAILED -> entry.ifMatch
            UploadStatus.WAITING, UploadStatus.UPLOADING -> null
        }
    }

    private suspend fun tus(entry: UploadEntry, copy: File, target: TusTarget, onProgress: (Long) -> Unit, restarted: Boolean): SyncItem {
        val length = copy.length()
        var url: HttpUrl? = entry.tusUrl?.toHttpUrlOrNull()?.takeIf { SyncApi.sameOrigin(it, api.origin) }
        var offset = 0L
        if (url != null) {
            offset = try {
                tus.head(url)
            } catch (e: SyncError.Http) {
                if (e.status == 404 || e.status == 410) { url = null; 0L } else throw e
            }
        }
        if (url == null) {
            when (val created = tus.create(length, target, entry.modifiedAt)) {
                is TusCreated.Completed -> return created.item
                is TusCreated.Created -> {
                    url = created.url
                    queue.update(entry.id) { it.copy(tusUrl = created.url.toString(), tusOffset = 0, sent = 0) } ?: throw RemovedSignal()
                }
            }
        }
        val uploadUrl = url!!
        onProgress(offset)
        var busy = 0
        while (true) {
            val chunk = minOf(chunkSize, length - offset)      // 0 at the final offset: retries a failed publish (§7.5)
            val base = offset
            val result = try {
                tus.patch(uploadUrl, offset, copy, chunk) { sent -> onProgress(base + sent) }
            } catch (e: SyncError.Http) {
                when (e.status) {
                    404, 410 -> {
                        if (restarted) throw e
                        val fresh = queue.update(entry.id) { it.copy(tusUrl = null, tusOffset = 0, sent = 0) } ?: throw RemovedSignal()
                        return tus(fresh, copy, target, onProgress, restarted = true)
                    }
                    409, 423 -> {                                // offset mismatch / being published: re-read the offset
                        if (++busy > 3) throw e
                        delay(1_000)
                        offset = tus.head(uploadUrl)
                        continue
                    }
                    else -> throw e
                }
            }
            busy = 0
            when (result) {
                is TusPatchResult.Completed -> return result.item
                is TusPatchResult.Offset -> {
                    if (chunk == 0L || result.offset <= base) throw SyncError.InvalidResponse("tus: no progress at offset $base")
                    offset = result.offset
                    queue.update(entry.id) { it.copy(tusOffset = offset, sent = offset) } ?: throw RemovedSignal()
                }
            }
        }
    }

    private fun map(e: SyncError): UploadOutcome = when (e) {
        is SyncError.SignInRequired -> UploadOutcome.Failed(UploadFailure.SIGNED_OUT, null)
        is SyncError.Transport -> UploadOutcome.Retry(e.message)
        is SyncError.InvalidResponse -> UploadOutcome.Failed(UploadFailure.OTHER, e.message)
        is SyncError.Http -> when {
            e.status == 401 -> UploadOutcome.Failed(UploadFailure.SIGNED_OUT, e.serverMessage)
            e.status == 403 -> UploadOutcome.Failed(UploadFailure.READ_ONLY, e.serverMessage)
            e.status == 404 -> UploadOutcome.Failed(UploadFailure.TARGET_GONE, e.serverMessage)
            e.status == 413 -> UploadOutcome.Failed(UploadFailure.TOO_LARGE, e.serverMessage)
            e.status == 507 -> UploadOutcome.Failed(UploadFailure.INSUFFICIENT_STORAGE, e.serverMessage)
            e.status == 503 && e.code == ErrorCodes.SPACE_UNAVAILABLE -> UploadOutcome.Failed(UploadFailure.SPACE_UNAVAILABLE, e.serverMessage)
            e.status == 400 && e.code == ErrorCodes.INVALID_NAME -> UploadOutcome.Failed(UploadFailure.INVALID_NAME, e.serverMessage)
            e.status == 423 || e.status == 429 || e.status >= 500 -> UploadOutcome.Retry(e.serverMessage)
            else -> UploadOutcome.Failed(UploadFailure.OTHER, e.serverMessage ?: "HTTP ${e.status}")
        }
    }
}
