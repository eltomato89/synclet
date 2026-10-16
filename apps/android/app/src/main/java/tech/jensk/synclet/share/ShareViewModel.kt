package tech.jensk.synclet.share

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.ShareTarget

class ShareViewModel(
    val accounts: List<Account>,
    selectedKey: String?,
    lastTarget: ShareTarget?,
    private val sessionOf: (String) -> AccountSession?,
    private val personalName: String,
    private val upload: suspend (ShareTarget) -> Int,
    private val remember: suspend (ShareTarget) -> Unit,
) : ViewModel() {
    data class State(
        val account: Account? = null, val target: ShareTarget? = null, val checking: Boolean = false,
        val busy: Boolean = false, val done: Int? = null, val error: Throwable? = null, val needsAccount: Boolean = false,
    )

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()
    private var checkJob: Job? = null

    init {
        val account = accounts.firstOrNull { it.key == lastTarget?.accountKey }
            ?: accounts.firstOrNull { it.key == selectedKey } ?: accounts.firstOrNull()
        if (account == null) {
            mutable.value = State(needsAccount = true)
        } else {
            mutable.value = State(account = account, checking = lastTarget != null && lastTarget.accountKey == account.key,
                target = if (lastTarget != null && lastTarget.accountKey == account.key) null else root(account))
            if (mutable.value.checking) check(account, lastTarget!!)
        }
    }

    private fun root(account: Account) = ShareTarget(account.key, "root", personalName)

    private fun check(account: Account, last: ShareTarget) {
        checkJob = viewModelScope.launch {
            val exists = try {
                sessionOf(account.key)?.api?.item(last.folderId)?.isFolder == true
            } catch (e: CancellationException) { throw e } catch (e: Exception) { false }
            mutable.update { if (it.account?.key != account.key) it else it.copy(checking = false, target = if (exists) last else root(account)) }
        }
    }

    fun selectAccount(key: String) {
        val account = accounts.firstOrNull { it.key == key } ?: return
        checkJob?.cancel()
        mutable.update { it.copy(account = account, target = root(account), checking = false) }
    }

    fun pickFolder(id: String, name: String) {
        val account = mutable.value.account ?: return
        checkJob?.cancel()
        mutable.update { it.copy(target = ShareTarget(account.key, id, name), checking = false) }
    }

    fun upload() = viewModelScope.launch {
        val target = mutable.value.target ?: return@launch
        mutable.update { it.copy(busy = true, error = null) }
        try {
            val n = upload(target)
            remember(target)
            mutable.update { it.copy(busy = false, done = n) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            mutable.update { it.copy(busy = false, error = e) }
        }
    }
}
