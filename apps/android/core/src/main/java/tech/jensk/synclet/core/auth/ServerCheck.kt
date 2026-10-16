package tech.jensk.synclet.core.auth

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import tech.jensk.synclet.core.api.ErrorBody
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.api.await

/** "Is there a Synclet server at this origin?" – same rules as the iOS app (LoginModel.checkServer). */
class ServerCheck(private val client: OkHttpClient) {
    suspend fun check(origin: HttpUrl): HttpUrl = withContext(Dispatchers.IO) {
        val host = ServerUrl.display(origin)
        val (healthStatus, healthBody) = get(origin.newBuilder().encodedPath("/api/health").build(), origin, host)
        if (healthStatus != 200 || !isJsonObject(healthBody)) throw LoginError.NotSynclet(host)
        val (capStatus, capBody) = get(origin.newBuilder().encodedPath("/api/sync/v1/capabilities").build(), origin, host)
        when (capStatus) {
            200 -> if (!isJsonObject(capBody)) throw LoginError.NotSynclet(host)
            404 -> Unit                     // older Synclet without the route
            401, 403 -> {                   // needs a device token: a Sync API error body proves it is Synclet
                val code = runCatching { SyncJson.decodeFromString(ErrorBody.serializer(), capBody).code }.getOrNull()
                if (code == null) throw LoginError.NotSynclet(host)
            }
            else -> throw LoginError.NotSynclet(host)
        }
        origin
    }

    private suspend fun get(url: HttpUrl, origin: HttpUrl, host: String): Pair<Int, String> {
        val request = Request.Builder().url(url).header("Accept", "application/json").build()
        val response = try {
            client.newCall(request).await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            throw LoginError.Unreachable(host)
        }
        response.use {
            // A redirect to another origin is not a Synclet server *at this address*.
            if (!SyncApi.sameOrigin(it.request.url, origin)) throw LoginError.NotSynclet(host)
            return it.code to (try { it.body.string() } catch (e: IOException) { throw LoginError.Unreachable(host) })
        }
    }

    private fun isJsonObject(text: String): Boolean =
        runCatching { SyncJson.parseToJsonElement(text) is JsonObject }.getOrDefault(false)
}
