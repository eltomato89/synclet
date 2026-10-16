package tech.jensk.synclet.ui.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.SearchHit
import tech.jensk.synclet.core.api.search

class SearchViewModel(
    private val session: AccountSession, private val folderId: String?, val folderName: String?,
    private val debounceMs: Long = 300, private val pageSize: Int = 50,
) : ViewModel() {
    data class State(
        val query: String = "", val scopeToFolder: Boolean = false, val hits: List<SearchHit> = emptyList(),
        val total: Int = 0, val loading: Boolean = false, val error: Throwable? = null,
    )

    private val mutable = MutableStateFlow(State(scopeToFolder = folderId != null))
    val state: StateFlow<State> = mutable.asStateFlow()
    private var job: Job? = null

    fun onQueryChange(q: String) { mutable.update { it.copy(query = q) }; search(reset = true) }
    fun setScopeToFolder(on: Boolean) { mutable.update { it.copy(scopeToFolder = on) }; search(reset = true) }
    fun loadMore() { val s = mutable.value; if (!s.loading && s.hits.size < s.total) search(reset = false) }
    fun retry() = search(reset = true)

    private fun search(reset: Boolean) {
        job?.cancel()
        val s = mutable.value
        val q = s.query.trim().take(200)
        if (q.isEmpty()) { mutable.update { State(scopeToFolder = it.scopeToFolder) }; return }
        job = viewModelScope.launch {
            if (reset) delay(debounceMs)
            mutable.update { it.copy(loading = true, error = null) }
            try {
                val offset = if (reset) 0 else s.hits.size
                val page = session.api.search(q, pageSize, offset, folder = folderId.takeIf { s.scopeToFolder })
                mutable.update { it.copy(hits = if (reset) page.hits else it.hits + page.hits, total = page.total, loading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(loading = false, error = e) }
            }
        }
    }
}
