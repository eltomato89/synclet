package tech.jensk.synclet.core.events

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull

class ReconnectPolicyTest {
    private val policy = ReconnectPolicy(random = { 0.5 })

    @Test fun exponentialFromOneSecondCappedAtSixty() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L),
            (0..7).map { policy.delayMs(Disconnect.Network, it) })
    }

    @Test fun noReconnectAfterUnauthorized() {
        assertNull(policy.delayMs(Disconnect.Unauthorized, 0))
        assertNull(policy.delayMs(Disconnect.Http(401, null), 3))
    }

    @Test fun maximumFor404And429AndNonEventStreamAndTooManyStreams() {
        assertEquals(60_000L, policy.delayMs(Disconnect.Http(404, null), 0))
        assertEquals(60_000L, policy.delayMs(Disconnect.Http(429, null), 0))
        assertEquals(60_000L, policy.delayMs(Disconnect.NotEventStream, 0))
        assertEquals(60_000L, policy.delayMs(Disconnect.Bye("too_many_streams"), 0))
        assertEquals(1_000L, policy.delayMs(Disconnect.Bye("server_shutdown"), 0))
    }

    @Test fun retryAfterWinsWhenLonger() {
        assertEquals(120_000L, policy.delayMs(Disconnect.Http(429, 120), 0))
    }

    @Test fun jitterStaysWithinTwentyPercentAndBelowMax() {
        assertEquals(800L, ReconnectPolicy(random = { 0.0 }).delayMs(Disconnect.Network, 0))
        assertEquals(1_200L, ReconnectPolicy(random = { 1.0 }).delayMs(Disconnect.Network, 0))
        assertEquals(60_000L, ReconnectPolicy(random = { 1.0 }).delayMs(Disconnect.Network, 10))
    }

    @Test fun retryAfterIsCappedAtTenMinutes() {
        assertEquals(600_000L, policy.delayMs(Disconnect.Http(429, 86_400), 0))
    }
}
