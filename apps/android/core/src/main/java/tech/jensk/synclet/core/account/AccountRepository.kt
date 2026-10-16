package tech.jensk.synclet.core.account

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import tech.jensk.synclet.core.api.AppTokens
import tech.jensk.synclet.core.api.FixedTokenSource
import tech.jensk.synclet.core.api.SyncAccount
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.DeviceRegistrar

/** The signed-in accounts: stored metadata (AccountStore), device tokens (TokenVault) and one live session each. */
class AccountRepository(
    private val store: AccountStore,
    private val vault: TokenVault,
    private val http: OkHttpClient,
    private val browserLogin: BrowserLogin,
    private val registrar: DeviceRegistrar,
    private val deviceName: String,
    private val installationId: String?,
    private val appVersion: String,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val onAccountsChanged: () -> Unit = {},
    private val onSignedIn: suspend (String) -> Unit = {},
    private val onSignedOut: suspend (String) -> Unit = {},
) {
    private val sessions = ConcurrentHashMap<String, AccountSession>()
    private val signInMutex = Mutex()
    val accounts: StateFlow<List<Account>> = store.accounts

    /** Reads accounts and tokens; an account without a readable token (e.g. the Keystore key is gone) needs a new sign-in. */
    suspend fun load() {
        store.load()
        for (account in store.accounts.value) {
            val token = vault.load(account.key)
            sessions[account.key] = newSession(account.key, account.origin, token)
            if (token == null && !account.needsSignIn) store.update(account.key) { it.copy(needsSignIn = true) }
        }
    }

    fun session(key: String): AccountSession? = sessions[key]

    /** Browser login finished: register this device, store its token, end the login session (SYNC_API §2.1 step 5). */
    suspend fun completeBrowserLogin(origin: HttpUrl, tokens: AppTokens): Account {
        try {
            val registration = registrar.register(origin, tokens.accessToken, deviceName, installationId, appVersion)
            val account = try {
                SyncApi(origin, http, FixedTokenSource(registration.token)).account()
            } catch (e: CancellationException) { throw e } catch (e: Exception) { registration.account }
            return activate(origin, registration.token, account)
        } finally {
            browserLogin.endSession(origin, tokens.refreshToken)
        }
    }

    /** Debug sign-in and instrumented tests: an already registered device token. */
    suspend fun addWithDeviceToken(origin: HttpUrl, deviceToken: String): Account =
        activate(origin, deviceToken, SyncApi(origin, http, FixedTokenSource(deviceToken)).account())

    suspend fun refreshAccount(key: String): Account? {
        val session = sessions[key] ?: return null
        val remote = session.api.account()
        return store.update(key) {
            it.copy(displayName = remote.displayName, email = remote.email, spaces = remote.spaces,
                quotaBytes = remote.quotaBytes, usedBytes = remote.usedBytes, maxUploadBytes = remote.maxUploadBytes)
        }
    }

    suspend fun signOut(key: String) {
        sessions[key]?.let { session ->
            withTimeoutOrNull(5_000) {
                try { session.api.revokeCurrentDevice() } catch (e: CancellationException) { throw e } catch (e: Exception) { }
            }
            session.tokens.clear()
        }
        vault.delete(key)
        store.remove(key)
        sessions.remove(key)
        onSignedOut(key)
        onAccountsChanged()
    }

    private suspend fun activate(origin: HttpUrl, token: String, remote: SyncAccount): Account {
        val key = remote.organizationId
        val account = signInMutex.withLock {
            vault.save(key, token)
            val previous = store.get(key)
            val account = Account.from(origin, remote, clock()).copy(needsSignIn = false, addedAt = previous?.addedAt ?: clock())
            store.upsert(account)
            val existing = sessions[key]
            if (existing != null && SyncApi.sameOrigin(existing.api.origin, origin)) existing.tokens.replace(token)
            else sessions[key] = newSession(key, origin, token)
            account
        }
        onSignedIn(key)
        onAccountsChanged()
        return account
    }

    /**
     * The 401 callback and a re-login both write `needsSignIn` under [signInMutex]; the callback re-checks the
     * token state inside the lock, so a late callback can never flag an account that was signed in again meanwhile.
     */
    private fun newSession(key: String, origin: HttpUrl, token: String?): AccountSession {
        lateinit var tokens: AccountTokens
        tokens = AccountTokens(key, token) { accountKey, _ ->
            scope.launch {
                signInMutex.withLock {
                    if (tokens.signInRequired) store.update(accountKey) { it.copy(needsSignIn = true) }
                }
                onAccountsChanged()
            }
        }
        return AccountSession(key, SyncApi(origin, http, tokens), tokens, store::get)
    }
}
