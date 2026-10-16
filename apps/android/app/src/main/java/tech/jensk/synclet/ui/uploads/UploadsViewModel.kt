package tech.jensk.synclet.ui.uploads

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import tech.jensk.synclet.core.upload.UploadEntry
import tech.jensk.synclet.core.upload.UploadQueue
import tech.jensk.synclet.core.upload.UploadStatus

class UploadsViewModel(
    private val queue: UploadQueue,
    private val schedule: (accountKey: String, restart: Boolean) -> Unit,
    private val terminate: suspend (UploadEntry) -> Unit,
) : ViewModel() {
    val rows: StateFlow<List<UploadEntry>> = queue.entries.map { entries ->
        val order = mapOf(UploadStatus.UPLOADING to 0, UploadStatus.WAITING to 1, UploadStatus.FAILED to 2, UploadStatus.DONE to 3)
        entries.sortedWith(compareBy<UploadEntry> { order[it.status] }
            .thenByDescending { if (it.status == UploadStatus.DONE) it.finishedAt ?: 0 else 0 }
            .thenBy { it.createdAt })
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Only offered for failed entries: a restart (REPLACE) would interrupt a running upload. */
    fun retry(entry: UploadEntry) = viewModelScope.launch { queue.retry(entry.id); schedule(entry.accountKey, true) }

    fun remove(entry: UploadEntry) = viewModelScope.launch {
        val removed = queue.remove(entry.id) ?: return@launch
        if (removed.tusUrl != null) {
            try { terminate(removed) } catch (e: CancellationException) { throw e } catch (_: Exception) { /* best effort */ }
        }
    }

    fun clearDone() = viewModelScope.launch {
        rows.value.filter { it.status == UploadStatus.DONE }.forEach { queue.remove(it.id) }
    }
}
