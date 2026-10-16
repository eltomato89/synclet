package tech.jensk.synclet.ui.trash

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.api.TrashEntry
import tech.jensk.synclet.core.api.deleteTrash
import tech.jensk.synclet.core.api.emptyTrash
import tech.jensk.synclet.core.api.restoreTrash
import tech.jensk.synclet.core.api.trash
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.ui.components.UiMessage

class TrashViewModel(
    private val session: AccountSession, private val publish: (FolderChange) -> Unit,
) : ViewModel() {
    /** [first] is null for entries of a space the account no longer lists. */
    data class State(
        val groups: List<Pair<SyncSpace?, List<TrashEntry>>> = emptyList(), val loading: Boolean = true,
        val error: Throwable? = null, val message: UiMessage? = null,
    ) {
        val entries: List<TrashEntry> get() = groups.flatMap { it.second }
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch { reload() }
    }

    private suspend fun reload() {
        mutable.update { it.copy(loading = true, error = null) }
        try {
            val entries = session.api.trash()
            mutable.update { it.copy(groups = group(entries), loading = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutable.update { it.copy(loading = false, error = e) }
        }
    }

    private fun group(entries: List<TrashEntry>): List<Pair<SyncSpace?, List<TrashEntry>>> {
        val spaces = session.layout.spaces
        val known = spaces.mapNotNull { space ->
            entries.filter { (it.spaceId ?: SyncSpace.PERSONAL) == space.id }.takeIf { it.isNotEmpty() }?.let { space to it }
        }
        val unknown = entries.filter { e -> spaces.none { it.id == (e.spaceId ?: SyncSpace.PERSONAL) } }
        return known + if (unknown.isEmpty()) emptyList() else listOf<Pair<SyncSpace?, List<TrashEntry>>>(null to unknown)
    }

    private fun remove(entry: TrashEntry) = mutable.update { s ->
        s.copy(groups = s.groups.map { (space, list) -> space to list.filter { it.id != entry.id } }.filter { it.second.isNotEmpty() })
    }

    fun restore(entry: TrashEntry) {
        viewModelScope.launch {
            try {
                val result = session.api.restoreTrash(entry.id)
                remove(entry)
                mutable.update {
                    it.copy(message = UiMessage.Text(
                        if (result.renamed) R.string.trash_restored_renamed else R.string.trash_restored, listOf(result.item.name)))
                }
                publish(FolderChange.Everything(session.key))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(message = UiMessage.Error(e)) }
            }
        }
    }

    fun deleteForever(entry: TrashEntry) {
        viewModelScope.launch {
            try {
                session.api.deleteTrash(entry.id)
                remove(entry)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(message = UiMessage.Error(e)) }
            }
        }
    }

    fun emptyAll() {
        viewModelScope.launch {
            try {
                val spaces = state.value.entries.map { it.spaceId ?: SyncSpace.PERSONAL }.distinct()
                for (space in spaces) session.api.emptyTrash(space)
                reload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(message = UiMessage.Error(e)) }
                reload()
            }
        }
    }

    fun messageShown() = mutable.update { it.copy(message = null) }
}
