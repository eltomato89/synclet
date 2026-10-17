package tech.jensk.synclet.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountRepository
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.LoginError
import tech.jensk.synclet.core.auth.Pkce
import tech.jensk.synclet.core.auth.ServerCheck
import tech.jensk.synclet.core.auth.ServerUrl

class LoginViewModel(
    private val check: ServerCheck,
    private val login: BrowserLogin,
    private val accounts: AccountRepository,
    private val pending: PendingLoginStore,
    private val allowHttp: Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Accounts loaded (AppGraph.awaitReady) – a redirect may arrive in a process that is still starting. */
    private val ready: suspend () -> Unit = {},
    /** Where the completion runs; the app scope in production, so leaving the screen cannot cut it short. */
    private val workScope: CoroutineScope? = null,
) : ViewModel() {
    data class State(val busy: Boolean = false, val error: Throwable? = null, val done: Account? = null)
    private val mutableState = MutableStateFlow(State())
    val state: StateFlow<State> = mutableState.asStateFlow()

    /** Checks the server and returns the authorize URL to open in a Custom Tab (null + error on failure). */
    suspend fun prepare(input: String, loginHint: String?): HttpUrl? {
        mutableState.value = State(busy = true)
        return try {
            val origin = check.check(ServerUrl.normalize(input, allowHttp))
            val pkce = Pkce.create()
            withContext(Dispatchers.IO) { pending.save(PendingLogin(origin.toString(), pkce.verifier, pkce.state, loginHint, clock())) }
            mutableState.value = State()
            login.authorizeUrl(origin, pkce.challenge, pkce.state, loginHint)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            mutableState.value = State(error = e)
            null
        }
    }

    /** The browser came back with synclet://oauth?…; the pending login is consumed whatever happens. */
    fun complete(redirect: String) {
        (workScope ?: viewModelScope).launch {
            mutableState.value = State(busy = true)
            try {
                val p = withContext(Dispatchers.IO) { pending.consume() } ?: throw LoginError.Expired
                val code = BrowserLogin.codeFromRedirect(redirect, p.state)
                val origin = p.origin.toHttpUrl()
                // Before the one-time code is spent: if the app cannot start, nothing is left half signed in.
                ready()
                val tokens = login.exchangeCode(origin, code, p.verifier)
                mutableState.value = State(done = accounts.completeBrowserLogin(origin, tokens))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                mutableState.value = State(error = e)
            }
        }
    }

    fun reportNoBrowser() { mutableState.value = State(error = NoBrowserException()) }
    class NoBrowserException : Exception("no browser")
}
