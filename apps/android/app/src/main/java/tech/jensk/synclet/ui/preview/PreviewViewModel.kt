package tech.jensk.synclet.ui.preview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import java.text.Collator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.PreviewText
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.previewText
import tech.jensk.synclet.core.cache.FileCache
import tech.jensk.synclet.core.cache.ListingCache

class PreviewViewModel(
    private val session: AccountSession,
    private val accountKey: String,
    private val folderId: String?,
    private val itemId: String,
    private val listingCache: ListingCache,
    private val fileCache: FileCache,
) : ViewModel() {
    data class State(
        val siblings: List<SyncItem> = emptyList(), val index: Int = 0, val loading: Boolean = true,
        val error: Throwable? = null, val progress: Map<String, Float> = emptyMap(),
    )

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    init { viewModelScope.launch { load() } }

    private suspend fun load() {
        try {
            val item = listingCache.item(accountKey, itemId) ?: session.api.item(itemId).also { listingCache.putItem(accountKey, it) }
            // Without a folder (Recent/Search without parent) only the item itself is shown; a failing sibling
            // listing degrades to the single item instead of an error.
            val all = folderId?.let { id ->
                listingCache.get(accountKey, id)?.takeIf { it.complete }?.items
                    ?: runCatching { session.api.allChildren(id).also { listingCache.put(accountKey, id, it) } }
                        .onFailure { if (it is CancellationException) throw it }.getOrNull()
            } ?: listOf(item)
            val collator = Collator.getInstance()
            val files = all.filterNot { it.isFolder }.sortedWith { a, b -> collator.compare(a.name, b.name) }
                .let { list -> if (list.any { it.id == itemId }) list else listOf(item) }
            mutable.value = State(files, files.indexOfFirst { it.id == itemId }.coerceAtLeast(0), loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.value = State(loading = false, error = e)
        }
    }

    suspend fun text(item: SyncItem): PreviewText = session.api.previewText(item.id)

    /** Streaming URL without Authorization (download token, purpose preview, 6 h) – Range is supported (§6.2). */
    suspend fun mediaUrl(item: SyncItem): String = session.api.resolve(session.api.downloadToken(item.id, "preview").url).toString()

    suspend fun original(item: SyncItem): File = fileCache.fetch(session.api, accountKey, item) { done, total ->
        if (total != null && total > 0) mutable.update { it.copy(progress = it.progress + (item.id to done.toFloat() / total)) }
    }.also { mutable.update { it.copy(progress = it.progress + (item.id to 1f)) } }
}
