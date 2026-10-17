package tech.jensk.synclet.core.account

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tech.jensk.synclet.core.api.SyncError

class AccountTokensTest {
    private fun http401() = SyncError.Http(401, "device_revoked", "revoked")

    @Test fun parallelUnauthorizedMarksTheAccountExactlyOnce() {
        val calls = AtomicInteger()
        val tokens = AccountTokens("k", "syd_a") { _, _ -> calls.incrementAndGet() }
        val pool = Executors.newFixedThreadPool(16)
        val start = CountDownLatch(1)
        repeat(64) { pool.submit { start.await(); tokens.onUnauthorized("syd_a", http401()) } }
        start.countDown()
        pool.shutdown(); pool.awaitTermination(5, TimeUnit.SECONDS)
        assertEquals(1, calls.get())
        assertTrue(tokens.signInRequired)
        assertNull(tokens.token())
    }

    @Test fun staleTokenAfterReLoginDoesNotMarkTheAccount() {
        val calls = AtomicInteger()
        val tokens = AccountTokens("k", "syd_old") { _, _ -> calls.incrementAndGet() }
        tokens.replace("syd_new")
        tokens.onUnauthorized("syd_old", http401())    // a request that was still running with the old token
        assertEquals(0, calls.get())
        assertEquals("syd_new", tokens.token())
    }

    @Test fun replaceClearsSignInRequired() {
        val tokens = AccountTokens("k", "syd_a") { _, _ -> }
        tokens.onUnauthorized("syd_a", http401())
        tokens.replace("syd_b")
        assertFalse(tokens.signInRequired)
        assertEquals("syd_b", tokens.token())
    }

    @Test fun missingInitialTokenStartsSignedOut() {
        val tokens = AccountTokens("k", null) { _, _ -> }
        assertTrue(tokens.signInRequired)
        assertNull(tokens.token())
    }
}
