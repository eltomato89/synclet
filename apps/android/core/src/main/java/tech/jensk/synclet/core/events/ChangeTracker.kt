package tech.jensk.synclet.core.events

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import tech.jensk.synclet.core.api.ErrorCodes
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError

data class ChangeSet(val space: String, val folderIds: Set<String>, val itemIds: Set<String>, val reset: Boolean)

/**
 * Per-space change cursors of one account, kept in memory while the app is in the foreground. Turns events and
 * polling into the set of folders whose listings changed. `knownParent(id)` is the parent the app last saw
 * for an item (ListingCache) – needed for deletes and moves, whose old parent the journal does not report.
 */
class ChangeTracker(private val api: SyncApi) {
    private val mutex = Mutex()
    private val cursors = HashMap<String, String>()

    suspend fun onHello(cursors: Map<String, String>, knownParent: (String) -> String?): List<ChangeSet> = mutex.withLock {
        val result = ArrayList<ChangeSet>()
        for ((space, head) in cursors) {
            val stored = this.cursors[space]
            if (stored == null) this.cursors[space] = head          // first contact: views load fresh anyway
            else if (stored != head) result += drainLocked(space, knownParent)
        }
        this.cursors.keys.retainAll(cursors.keys)
        result
    }

    suspend fun onChanges(space: String, cursor: String, knownParent: (String) -> String?): ChangeSet? = mutex.withLock {
        if (cursors[space] == cursor) null else drainLocked(space, knownParent)
    }

    suspend fun drain(space: String, knownParent: (String) -> String?): ChangeSet = mutex.withLock { drainLocked(space, knownParent) }

    suspend fun drainAll(spaces: Collection<String>, knownParent: (String) -> String?): List<ChangeSet> =
        mutex.withLock { spaces.map { drainLocked(it, knownParent) } }

    suspend fun forget(space: String) { mutex.withLock { cursors.remove(space) } }

    private suspend fun drainLocked(space: String, knownParent: (String) -> String?): ChangeSet {
        var cursor = cursors[space] ?: return baseline(space)
        val folders = HashSet<String>()
        val items = HashSet<String>()
        var malformed = false
        try {
            while (true) {
                val page = api.changes(space, cursor)
                for (change in page.changes) {
                    // A change without any id (SyncChange.itemId would throw) cannot be attributed: reload the space.
                    val id = change.item?.id ?: change.id
                    if (id == null) { malformed = true; continue }
                    items += id
                    knownParent(id)?.let { folders += it }
                    change.item?.parentId?.let { folders += it }
                }
                cursor = page.cursor
                if (!page.hasMore) break
            }
        } catch (e: SyncError.Http) {
            if (e.status == 410 && e.code == ErrorCodes.CURSOR_EXPIRED) return baseline(space)
            throw e
        }
        cursors[space] = cursor
        return ChangeSet(space, folders, items, reset = malformed)
    }

    private suspend fun baseline(space: String): ChangeSet {
        cursors[space] = api.cursor(space)
        return ChangeSet(space, emptySet(), emptySet(), reset = true)
    }
}
