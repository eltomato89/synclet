package tech.jensk.synclet.core.events

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.testing.RecordingTokens
import tech.jensk.synclet.core.testing.api
import tech.jensk.synclet.core.testing.error

class EventStreamTest {
    private val server = MockWebServer()
    private val tokens = RecordingTokens()
    private val sleeps = CopyOnWriteArrayList<Long>()
    @Before fun setUp() = server.start()
    @After fun tearDown() = server.shutdown()

    private fun stream() = EventStream(server.api(tokens), OkHttpClient(), ReconnectPolicy(random = { 0.5 }),
        sleep = { sleeps += it }, uptimeMs = { 0L })

    private fun sse(body: String) = MockResponse().setResponseCode(200)
        .setHeader("Content-Type", "text/event-stream").setBody(body)

    @Test fun parsesEventsIgnoresPingsAndReconnectsAfterClose() = runBlocking {
        server.enqueue(sse("event: hello\ndata: {\"cursor\":\"5\",\"cursors\":{\"personal\":\"5\",\"s1\":\"9\"}}\n\n" +
            ": ping\n\nevent: changes\ndata: {\"space\":\"personal\",\"cursor\":\"6\"}\n\nevent: account\ndata: {}\n\n"))
        server.enqueue(sse("event: hello\ndata: {\"cursor\":\"6\",\"cursors\":{}}\n\n"))
        val events = withTimeout(5_000) { stream().events().take(4).toList() }
        assertEquals(SyncEvent.Hello("5", mapOf("personal" to "5", "s1" to "9")), events[0])
        assertEquals(SyncEvent.Changes("personal", "6"), events[1])
        assertEquals(SyncEvent.AccountChanged, events[2])
        assertEquals(SyncEvent.Hello("6", emptyMap()), events[3])
        assertEquals(1_000L, sleeps.first())                      // a reconnect after the stream ended
        assertEquals("text/event-stream", server.takeRequest().getHeader("Accept"))
    }

    @Test fun unauthorizedStopsAndFlagsTheToken() = runBlocking {
        server.error(401, "device_revoked")
        val stream = stream()
        val events = withTimeout(5_000) { stream.events().toList() }   // completes by itself
        assertTrue(events.isEmpty())
        assertEquals(StreamState.SIGN_IN_REQUIRED, stream.state.value)
        assertEquals("device_revoked", tokens.failures.single().second.code)
        assertTrue(sleeps.isEmpty())
    }

    @Test fun nonEventStreamResponseBacksOffToMaximum() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "text/html").setBody("<html>"))
        server.enqueue(sse("event: hello\ndata: {\"cursor\":\"1\"}\n\n"))
        withTimeout(5_000) { stream().events().first() }
        assertEquals(60_000L, sleeps.first())
    }

    @Test fun byeTooManyStreamsWaitsTheMaximum() = runBlocking {
        server.enqueue(sse("event: bye\ndata: {\"reason\":\"too_many_streams\"}\n\n"))
        server.enqueue(sse("event: hello\ndata: {\"cursor\":\"1\"}\n\n"))
        val events = withTimeout(5_000) { stream().events().take(2).toList() }
        assertEquals(SyncEvent.Bye("too_many_streams"), events[0])
        assertEquals(60_000L, sleeps.first())
    }

    @Test fun noTokenMeansSignInRequiredWithoutRequest() = runBlocking {
        tokens.value = null
        val stream = stream()
        withTimeout(5_000) { stream.events().toList() }
        assertEquals(StreamState.SIGN_IN_REQUIRED, stream.state.value)
        assertEquals(0, server.requestCount)
    }
}
