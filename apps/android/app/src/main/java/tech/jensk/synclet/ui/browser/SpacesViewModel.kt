package tech.jensk.synclet.ui.browser

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.core.account.AccountRepository
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.events.FolderChange

/** The spaces of one account, as the stored account (session.layout) lists them, in server order. */
class SpacesViewModel(
    private val accounts: AccountRepository,
    private val accountKey: String,
    changes: Flow<FolderChange>,
    private val personalName: String,
) : ViewModel() {
    data class SpaceRow(val space: SyncSpace, val name: String, val available: Boolean, val readOnly: Boolean)
    data class State(val spaces: List<SpaceRow> = emptyList(), val refreshing: Boolean = false, val error: Throwable? = null)

    private val mutable = MutableStateFlow(State(rows()))
    val state: StateFlow<State> = mutable.asStateFlow()

    init {
        viewModelScope.launch { accounts.accounts.collect { rebuild() } }
        viewModelScope.launch {
            changes.filter { it.accountKey == accountKey && it is FolderChange.Everything }.collect { rebuild() }
        }
    }

    fun refresh() {
        if (mutable.value.refreshing) return
        mutable.update { it.copy(refreshing = true, error = null) }
        viewModelScope.launch {
            try {
                accounts.refreshAccount(accountKey)
                mutable.update { it.copy(spaces = rows(), refreshing = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutable.update { it.copy(refreshing = false, error = e) }
            }
        }
    }

    fun errorShown() = mutable.update { it.copy(error = null) }

    private fun rebuild() = mutable.update { it.copy(spaces = rows()) }

    private fun rows(): List<SpaceRow> {
        val layout = accounts.session(accountKey)?.layout ?: return emptyList()
        return layout.spaces.map {
            SpaceRow(it, layout.displayName(it, personalName), available = !it.isMissing, readOnly = !it.canWrite)
        }
    }
}
