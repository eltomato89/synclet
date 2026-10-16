package tech.jensk.synclet.core.events

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncJson

/** `GET /sync/v1/events` with reconnect (SYNC_API §5a). Cold: collecting connects, cancelling disconnects. */
class EventStream(
    private val api: SyncApi,
    private val client: OkHttpClient,
    private val policy: ReconnectPolicy = ReconnectPolicy(),
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val uptimeMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val mutableState = MutableStateFlow(StreamState.IDLE)
    val state: StateFlow<StreamState> = mutableState.asStateFlow()

    fun events(): Flow<SyncEvent> = channelFlow {
        var attempt = 0
        try {
            while (isActive) {
                mutableState.value = StreamState.CONNECTING
                val openedAt = uptimeMs()
                val reason = connectOnce { trySend(it) }
                if (uptimeMs() - openedAt >= policy.healthyAfterMs) attempt = 0
                val wait = policy.delayMs(reason, attempt)
                if (wait == null) {
                    mutableState.value = StreamState.SIGN_IN_REQUIRED
                    break
                }
                attempt++
                mutableState.value = StreamState.BACKING_OFF
                sleep(wait)
            }
        } finally {
            if (mutableState.value != StreamState.SIGN_IN_REQUIRED) mutableState.value = StreamState.IDLE
        }
    }.buffer(Channel.UNLIMITED)

    private suspend fun connectOnce(emit: (SyncEvent) -> Unit): Disconnect {
        val signed = api.eventsRequest() ?: return Disconnect.Unauthorized
        val done = CompletableDeferred<Disconnect>()
        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                mutableState.value = StreamState.CONNECTED
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                val event = parse(type, data) ?: return
                emit(event)
                if (event is SyncEvent.Bye) {
                    done.complete(Disconnect.Bye(event.reason))
                    eventSource.cancel()
                }
            }

            override fun onClosed(eventSource: EventSource) {
                done.complete(Disconnect.Closed)
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val reason = when {
                    response == null -> Disconnect.Network
                    response.code == 401 -> {
                        api.tokens.onUnauthorized(signed.token, SyncApi.errorFrom(response))
                        Disconnect.Unauthorized
                    }
                    response.code !in 200..299 ->
                        Disconnect.Http(response.code, response.header("Retry-After")?.trim()?.toLongOrNull())
                    else -> Disconnect.NotEventStream      // 200 that is not text/event-stream (proxy page)
                }
                done.complete(reason)
            }
        }
        val source = EventSources.createFactory(client).newEventSource(signed.request, listener)
        return try { done.await() } finally { source.cancel() }
    }

    @Serializable private data class HelloData(val cursor: String, val cursors: Map<String, String> = emptyMap())
    @Serializable private data class ChangesData(val space: String, val cursor: String)
    @Serializable private data class ByeData(val reason: String = "")

    internal fun parse(type: String?, data: String): SyncEvent? = try {
        when (type) {
            "hello" -> SyncJson.decodeFromString(HelloData.serializer(), data).let { SyncEvent.Hello(it.cursor, it.cursors) }
            "changes" -> SyncJson.decodeFromString(ChangesData.serializer(), data).let { SyncEvent.Changes(it.space, it.cursor) }
            "account" -> SyncEvent.AccountChanged
            "bye" -> SyncEvent.Bye(SyncJson.decodeFromString(ByeData.serializer(), data).reason)
            else -> null
        }
    } catch (e: Exception) {
        null
    }
}
