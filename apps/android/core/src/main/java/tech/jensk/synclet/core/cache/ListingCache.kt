package tech.jensk.synclet.core.cache

import tech.jensk.synclet.core.api.SyncItem

/** In-memory folder listings and an item index per account (app views and provider). Thread safe. */
class ListingCache(private val maxFoldersPerAccount: Int = 300, private val clock: () -> Long = System::currentTimeMillis) {
    data class Listing(val items: List<SyncItem>, val loadedAt: Long, val complete: Boolean, val error: String? = null)

    private class AccountCache(maxFolders: Int) {
        val listings = object : LinkedHashMap<String, Listing>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Listing>?) = size > maxFolders
        }
        val items = object : LinkedHashMap<String, SyncItem>(256, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, SyncItem>?) = size > 20_000
        }
    }

    private val accounts = HashMap<String, AccountCache>()
    private fun account(key: String) = accounts.getOrPut(key) { AccountCache(maxFoldersPerAccount) }

    @Synchronized fun get(accountKey: String, folderId: String): Listing? = account(accountKey).listings[folderId]

    @Synchronized fun put(accountKey: String, folderId: String, items: List<SyncItem>, complete: Boolean = true) {
        val cache = account(accountKey)
        cache.listings[folderId] = Listing(items, clock(), complete)
        items.forEach { cache.items[it.id] = it }
    }

    @Synchronized fun putError(accountKey: String, folderId: String, message: String) {
        val cache = account(accountKey)
        val old = cache.listings[folderId]
        cache.listings[folderId] = Listing(old?.items ?: emptyList(), clock(), old?.complete ?: false, message)
    }

    fun isFresh(listing: Listing, maxAgeMs: Long): Boolean = clock() - listing.loadedAt < maxAgeMs

    @Synchronized fun item(accountKey: String, id: String): SyncItem? = account(accountKey).items[id]
    @Synchronized fun putItem(accountKey: String, item: SyncItem) { account(accountKey).items[item.id] = item }
    @Synchronized fun removeItem(accountKey: String, id: String) { account(accountKey).items.remove(id) }
    @Synchronized fun parentOf(accountKey: String, id: String): String? = account(accountKey).items[id]?.parentId

    @Synchronized fun invalidate(accountKey: String, folderId: String) {
        val cache = account(accountKey)
        cache.listings[folderId]?.let { cache.listings[folderId] = it.copy(loadedAt = 0, error = null) }
    }

    @Synchronized fun invalidateAll(accountKey: String) {
        val cache = account(accountKey)
        cache.listings.keys.toList().forEach { k -> cache.listings[k] = cache.listings[k]!!.copy(loadedAt = 0, error = null) }
    }

    @Synchronized fun clear(accountKey: String) { accounts.remove(accountKey) }
}
