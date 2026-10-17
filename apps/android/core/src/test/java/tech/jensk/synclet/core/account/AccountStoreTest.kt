package tech.jensk.synclet.core.account

import java.io.File
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import tech.jensk.synclet.core.api.SyncAccount

class AccountStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private fun file() = File(tmp.root, "accounts.json")
    private fun account(key: String, name: String = "N") = Account(
        key = key, serverUrl = "https://files.example.com", userId = "u", username = "jens", displayName = name,
    )

    @Test fun persistsAndReloads() = runBlocking {
        val store = AccountStore(file())
        store.upsert(account("a")); store.upsert(account("b"))
        val again = AccountStore(file())
        again.load()
        assertEquals(listOf("a", "b"), again.accounts.value.map { it.key })
        assertTrue(file().readText().contains("\"v\":1"))
    }

    @Test fun upsertReplacesBySameKey() = runBlocking {
        val store = AccountStore(file())
        store.upsert(account("a", "Old")); store.upsert(account("a", "New"))
        assertEquals(1, store.accounts.value.size)
        assertEquals("New", store.get("a")?.displayName)
    }

    @Test fun updateAndRemove() = runBlocking {
        val store = AccountStore(file())
        store.upsert(account("a"))
        assertTrue(store.update("a") { it.copy(needsSignIn = true) }!!.needsSignIn)
        assertNull(store.update("zzz") { it })
        store.remove("a")
        assertTrue(store.accounts.value.isEmpty())
    }

    @Test fun corruptFileIsMovedAside() = runBlocking {
        file().writeText("{\"v\":1,\"accounts\":[")
        val store = AccountStore(file())
        store.load()
        assertTrue(store.accounts.value.isEmpty())
        assertTrue(tmp.root.listFiles()!!.any { it.name.startsWith("accounts.json.corrupt-") })
    }

    @Test fun accountFromSyncAccount() {
        val sync = SyncAccount(userId = "u1", displayName = "Jens", organizationId = "srv:u1", slug = "jens")
        val a = Account.from("https://files.example.com".toHttpUrl(), sync, 5)
        assertEquals("srv:u1", a.key)
        assertEquals("jens", a.username)
        assertEquals("https://files.example.com", a.serverUrl)
        assertEquals("jens@files.example.com", a.title)
    }
}
