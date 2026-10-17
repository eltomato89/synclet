package tech.jensk.synclet.ui.recent

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.recent

class RecentViewModel(private val session: AccountSession) : ViewModel() {
    data class State(val items: List<SyncItem> = emptyList(), val loading: Boolean = true, val error: Throwable? = null)

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            mutable.update { it.copy(loading = true, error = null) }
            try {
                val items = session.api.recent(limit = 100)
                mutable.update { State(items = items, loading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(loading = false, error = e) }
            }
        }
    }
}
