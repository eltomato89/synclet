package tech.jensk.synclet.ui.browser

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.AppSettings
import tech.jensk.synclet.core.account.SortOrder
import tech.jensk.synclet.core.account.ViewMode
import tech.jensk.synclet.core.api.ErrorCodes
import tech.jensk.synclet.core.api.OnConflict
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.ui.components.UiMessage

class FolderViewModel(
    private val session: AccountSession,
    private val folderId: String,
    private val listingCache: ListingCache,
    private val settings: AppSettings,
    changes: Flow<FolderChange>,
    private val publish: (FolderChange) -> Unit,
    private val pageSize: Int = 200,
) : ViewModel() {
    data class State(
        val folder: SyncItem? = null, val items: List<SyncItem> = emptyList(), val loading: Boolean = true,
        val refreshing: Boolean = false, val loadingMore: Boolean = false, val nextPageToken: String? = null,
        val error: Throwable? = null, val viewMode: ViewMode = ViewMode.LIST, val sort: SortOrder = SortOrder(),
        val selection: Set<String> = emptySet(), val message: UiMessage? = null,
    ) {
        val endReached: Boolean get() = nextPageToken == null
        val selectedItems: List<SyncItem> get() = items.filter { it.id in selection }
    }

    private val key = session.key
    private val mutable = MutableStateFlow(State(items = listingCache.get(key, folderId)?.items.orEmpty()))
    val state: StateFlow<State> = mutable.asStateFlow()
    private var loadJob: Job? = null
    private var loadMoreJob: Job? = null
    private var firstLoadDone = false
    /** Whether the latest load asked for folder mosaics; null until the first load has read the setting. */
    private var fetchedWithThumbnails: Boolean? = null
    /** Bumped when a refresh starts and when it replaces the listing; a page fetched for an older one is dropped. */
    private var generation = 0

    init {
        viewModelScope.launch {
            combine(settings.viewMode, settings.sortOrder) { mode, sort -> mode to sort }.collect { (mode, sort) ->
                val reloadForGrid = mode == ViewMode.GRID && fetchedWithThumbnails == false
                mutable.update { it.copy(viewMode = mode, sort = sort, items = sortItems(it.items, sort)) }
                // Folder mosaics only come with folderThumbnails=1; a first load still running without them restarts.
                // Before the first load finished it is restarted as the initial load (no pull-to-refresh spinner).
                if (reloadForGrid) refresh(initial = !firstLoadDone)
            }
        }
        viewModelScope.launch {
            changes.filter {
                it.accountKey == key && (it is FolderChange.Everything || (it as FolderChange.Folders).folderIds.contains(folderId))
            }.collect { refresh() }
        }
        refresh(initial = true)
    }

    fun refresh(initial: Boolean = false) {
        loadJob?.cancel()
        // A page 2 still on its way belongs to the old listing: it must not be merged into the new one.
        loadMoreJob?.cancel()
        loadMoreJob = null
        mutable.update { it.copy(loadingMore = false) }
        generation++
        loadJob = viewModelScope.launch {
            mutable.update { it.copy(loading = initial && it.items.isEmpty(), refreshing = !initial, error = null) }
            try {
                // From the setting itself: on open the stored GRID may not have reached the state yet.
                val grid = settings.viewMode.first() == ViewMode.GRID
                fetchedWithThumbnails = grid
                coroutineScope {
                    val folder = async { session.api.item(folderId) }
                    val page = async { session.api.children(folderId, null, pageSize, folderThumbnails = grid) }
                    val p = page.await()
                    val f = folder.await()
                    listingCache.put(key, folderId, p.items, complete = p.nextPageToken == null)
                    firstLoadDone = true
                    generation++
                    mutable.update {
                        it.copy(folder = f, items = sortItems(p.items, it.sort), nextPageToken = p.nextPageToken,
                            loading = false, refreshing = false, error = null,
                            selection = it.selection intersect p.items.map { i -> i.id }.toSet())
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                firstLoadDone = true
                mutable.update { it.copy(loading = false, refreshing = false, error = e) }
            }
        }
    }

    fun loadMore() {
        val token = mutable.value.nextPageToken ?: return
        if (mutable.value.loadingMore) return
        mutable.update { it.copy(loadingMore = true) }
        val startedFor = generation
        loadMoreJob = viewModelScope.launch {
            try {
                val page = session.api.children(folderId, token, pageSize, folderThumbnails = mutable.value.viewMode == ViewMode.GRID)
                if (startedFor != generation) {                 // the listing was reloaded meanwhile
                    mutable.update { it.copy(loadingMore = false) }
                    return@launch
                }
                mutable.update {
                    val all = (it.items + page.items).distinctBy { i -> i.id }
                    listingCache.put(key, folderId, all, complete = page.nextPageToken == null)
                    it.copy(items = sortItems(all, it.sort), nextPageToken = page.nextPageToken, loadingMore = false)
                }
            } catch (e: CancellationException) {
                mutable.update { it.copy(loadingMore = false) }
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(loadingMore = false, message = UiMessage.Error(e)) }
            }
        }
    }

    fun toggleSelection(id: String) = mutable.update { it.copy(selection = if (id in it.selection) it.selection - id else it.selection + id) }
    fun clearSelection() = mutable.update { it.copy(selection = emptySet()) }
    fun messageShown() = mutable.update { it.copy(message = null) }
    fun setViewMode(mode: ViewMode) = viewModelScope.launch { settings.setViewMode(mode) }
    fun setSort(order: SortOrder) = viewModelScope.launch { settings.setSortOrder(order) }

    /** [onResult] gets the error that should keep the name dialog open (name taken/invalid), else null. */
    fun createFolder(name: String, onResult: (Throwable?) -> Unit) = mutation(onResult) {
        val created = session.api.createFolder(folderId, name, OnConflict.FAIL)
        mutable.update { it.copy(items = sortItems(it.items.filterNot { i -> i.id == created.id } + created, it.sort)) }
        publish(FolderChange.Folders(key, setOf(folderId)))
    }

    fun rename(item: SyncItem, name: String, onResult: (Throwable?) -> Unit) = mutation(onResult) {
        val updated = session.api.patchItem(item.id, name = name, ifMatch = item.etag)
        mutable.update { s -> s.copy(items = sortItems(s.items.map { if (it.id == item.id) updated else it }, s.sort)) }
        publish(FolderChange.Folders(key, setOf(folderId)))
    }

    fun move(items: List<SyncItem>, targetFolderId: String) = mutation(null) {
        try {
            for (item in items) {
                session.api.patchItem(item.id, parentId = targetFolderId, ifMatch = item.etag)
                mutable.update { s -> s.copy(items = s.items.filterNot { it.id == item.id }, selection = s.selection - item.id) }
            }
        } finally {
            // Also after a partial failure: what did move is gone here and new there.
            publish(FolderChange.Folders(key, setOf(folderId, targetFolderId)))
        }
    }

    fun delete(items: List<SyncItem>) = mutation(null) {
        try {
            for (item in items) {
                try {
                    session.api.deleteItem(item.id, ifMatch = item.etag)
                } catch (e: SyncError.Http) {
                    if (e.status != 404) throw e                    // already gone counts as deleted
                }
                mutable.update { s -> s.copy(items = s.items.filterNot { it.id == item.id }, selection = s.selection - item.id) }
            }
        } finally {
            publish(FolderChange.Folders(key, setOf(folderId)))
        }
        mutable.update { it.copy(message = UiMessage.Text(R.plurals.browser_deleted, listOf(items.size), plural = true)) }
    }

    /** [onResult] is the name dialog's callback; without one (move, delete) every failure becomes a message. */
    private fun mutation(onResult: ((Throwable?) -> Unit)?, block: suspend () -> Unit) = viewModelScope.launch {
        try {
            block()
            onResult?.invoke(null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: SyncError.Http) {
            val nameProblem = e.code == ErrorCodes.NAME_CONFLICT || e.code == ErrorCodes.INVALID_NAME
            if (nameProblem && onResult != null) { onResult(e); return@launch }
            onResult?.invoke(null)
            mutable.update { it.copy(message = UiMessage.Error(e)) }
            // "Changed in the meantime" / "No longer available"; a move that hit a name conflict may have moved some items.
            if (e.status == 412 || e.status == 404 || nameProblem) refresh()
        } catch (e: Exception) {
            onResult?.invoke(null)
            mutable.update { it.copy(message = UiMessage.Error(e)) }
        }
    }
}
