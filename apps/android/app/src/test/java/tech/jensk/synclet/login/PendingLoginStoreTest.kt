package tech.jensk.synclet.login

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PendingLoginStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private var now = 1_000L
    private fun store() = PendingLoginStore(File(tmp.root, "pending-login.json")) { now }
    private val login = PendingLogin("https://files.example.com", "v".repeat(43), "st", "jens", 1_000L)

    @Test fun survivesANewProcessAndIsConsumedOnce() {
        store().save(login)
        assertEquals(login, store().consume())     // new instance = new process
        assertNull(store().consume())
    }
    @Test fun expiresAfterTenMinutes() {
        store().save(login)
        now += PendingLoginStore.TTL_MS + 1
        assertNull(store().consume())
    }
    @Test fun brokenFileReadsAsNothing() {
        File(tmp.root, "pending-login.json").writeText("{")
        assertNull(store().consume())
    }
}
