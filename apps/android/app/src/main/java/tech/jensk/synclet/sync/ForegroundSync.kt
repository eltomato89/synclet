package tech.jensk.synclet.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.core.account.AccountRepository
import tech.jensk.synclet.core.cache.ListingCache
import tech.jensk.synclet.core.events.ChangeSet
import tech.jensk.synclet.core.events.ChangeTracker
import tech.jensk.synclet.core.events.EventStream
import tech.jensk.synclet.core.events.FolderChange
import tech.jensk.synclet.core.events.StreamState
import tech.jensk.synclet.core.events.SyncEvent
import tech.jensk.synclet.provider.ProviderNotifier

/** Spec §2.4: one SSE stream per signed-in account while the app is in the foreground; polling every 60 s while it is down. */
class ForegroundSync(
    private val scope: CoroutineScope,
    private val accounts: AccountRepository,
    private val sseClient: OkHttpClient,
    private val listingCache: ListingCache,
    private val notifier: ProviderNotifier,
    private val pollIntervalMs: Long = 60_000,
) {
    private val mutableChanges = MutableSharedFlow<FolderChange>(extraBufferCapacity = 64)
    val changes: SharedFlow<FolderChange> = mutableChanges
    private val jobs = HashMap<String, Job>()
    @Volatile private var foreground = false

    /**
     * The one place that turns a change into "listings stale, provider notified, open views told":
     * used for server events, polling and local changes of the app itself (uploads, rename, delete, …).
     */
    fun publish(change: FolderChange) {
        when (change) {
            is FolderChange.Folders -> change.folderIds.forEach {
                listingCache.invalidate(change.accountKey, it); notifier.childrenChanged(change.accountKey, it)
            }
            is FolderChange.Everything -> { listingCache.invalidateAll(change.accountKey); notifier.topChanged(change.accountKey) }
        }
        mutableChanges.tryEmit(change)
    }

    @Synchronized fun onForeground() { foreground = true; reconcile(accounts.accounts.value) }
    @Synchronized fun onBackground() { foreground = false; jobs.values.forEach { it.cancel() }; jobs.clear() }
    @Synchronized fun onAccountsChanged(list: List<Account>) { if (foreground) reconcile(list) }

    private fun reconcile(list: List<Account>) {
        val wanted = list.filterNot { it.needsSignIn }.map { it.key }.toSet()
        (jobs.keys - wanted).forEach { jobs.remove(it)?.cancel() }
        (wanted - jobs.keys).forEach { key -> jobs[key] = run(key) }
    }

    private fun run(key: String): Job = scope.launch {
        val session = accounts.session(key) ?: return@launch
        val tracker = ChangeTracker(session.api)
        val stream = EventStream(session.api, sseClient)
        val knownParent = { id: String -> listingCache.parentOf(key, id) }
        val poller = launch {
            while (isActive) {
                delay(pollIntervalMs)
                val state = stream.state.value
                if (state != StreamState.CONNECTED && state != StreamState.SIGN_IN_REQUIRED) {
                    attempt { tracker.drainAll(session.layout.spaces.map { it.id }, knownParent) }.onSuccess { apply(key, it) }
                }
            }
        }
        stream.events().collect { event ->
            when (event) {
                is SyncEvent.Hello -> attempt { tracker.onHello(event.cursors, knownParent) }.onSuccess { apply(key, it) }
                is SyncEvent.Changes -> attempt { tracker.onChanges(event.space, event.cursor, knownParent) }
                    .onSuccess { set -> set?.let { apply(key, listOf(it)) } }
                SyncEvent.AccountChanged -> {
                    attempt { accounts.refreshAccount(key) }
                    notifier.rootsChanged()
                    publish(FolderChange.Everything(key))
                }
                is SyncEvent.Bye -> Unit
            }
        }
        poller.cancel()      // the stream only ends by itself when the account needs a new sign-in
    }

    private fun apply(key: String, sets: List<ChangeSet>) {
        for (set in sets) {
            when {
                set.reset -> publish(FolderChange.Everything(key))
                set.folderIds.isEmpty() && set.itemIds.isEmpty() -> Unit
                else -> {
                    set.itemIds.forEach { notifier.documentChanged(key, it) }
                    publish(FolderChange.Folders(key, set.folderIds))
                }
            }
        }
    }

    /** runCatching that lets cancellation through (moving to the background must stop the loop at once). */
    private inline fun <T> attempt(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }
}
