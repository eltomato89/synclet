package tech.jensk.synclet.core.account

import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.layout.SpaceLayout

/** Everything that talks to the server for one account. `account` is always the stored, current state. */
class AccountSession(val key: String, val api: SyncApi, val tokens: AccountTokens, private val lookup: (String) -> Account?) {
    val account: Account? get() = lookup(key)
    val layout: SpaceLayout get() = SpaceLayout(account?.spaces.orEmpty())
}
