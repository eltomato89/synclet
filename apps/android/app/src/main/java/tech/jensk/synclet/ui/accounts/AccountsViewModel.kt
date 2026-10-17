package tech.jensk.synclet.ui.accounts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.core.account.Account

class AccountsViewModel(private val graph: AppGraph) : ViewModel() {
    val accounts: StateFlow<List<Account>> = graph.accounts.accounts
    val selected: StateFlow<String?> = graph.selectedAccountKey

    fun select(key: String) { viewModelScope.launch { graph.settings.setSelectedAccount(key) } }

    /** Runs in the app scope: leaving the screen must not cut the revoke/cleanup short. */
    fun signOut(key: String) { graph.scope.launch { graph.accounts.signOut(key) } }
}
