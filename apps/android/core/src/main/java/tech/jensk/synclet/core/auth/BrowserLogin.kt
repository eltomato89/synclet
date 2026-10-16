package tech.jensk.synclet.core.auth

import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import tech.jensk.synclet.core.api.AppTokenRequest
import tech.jensk.synclet.core.api.AppTokens
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.api.await

/** OAuth 2.0 authorization code + PKCE against `<origin>/app-login` (SYNC_API §2.1). */
class BrowserLogin(
    private val client: OkHttpClient,
    val clientId: String = CLIENT_ID,
    val redirectUri: String = REDIRECT_URI,
) {
    /** Never follow redirects: the code, verifier and refresh cookie must not leave the origin. */
    private val noRedirects: OkHttpClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    fun authorizeUrl(origin: HttpUrl, challenge: String, state: String, loginHint: String? = null): HttpUrl =
        origin.newBuilder().encodedPath("/app-login").query(null).fragment(null)
            .addQueryParameter("client_id", clientId)
            .addQueryParameter("redirect_uri", redirectUri)
            .addQueryParameter("code_challenge", challenge)
            .addQueryParameter("code_challenge_method", "S256")
            .addQueryParameter("state", state)
            .apply { if (!loginHint.isNullOrBlank()) addQueryParameter("login_hint", loginHint) }
            .build()

    suspend fun exchangeCode(origin: HttpUrl, code: String, verifier: String): AppTokens = withContext(Dispatchers.IO) {
        val body = SyncJson.encodeToString(AppTokenRequest.serializer(), AppTokenRequest(code, verifier, clientId, redirectUri))
            .toRequestBody(JSON)
        val request = Request.Builder().url(origin.newBuilder().encodedPath("/api/auth/app/token").build())
            .header("Accept", "application/json").post(body).build()
        val response = try {
            noRedirects.newCall(request).await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            throw SyncError.Transport(e)
        }
        response.use {
            if (it.code !in 200..299) throw SyncApi.errorFrom(it)
            try {
                SyncJson.decodeFromString(AppTokens.serializer(), it.body.string())
            } catch (e: SerializationException) {
                throw SyncError.InvalidResponse("unexpected token response", e)
            }
        }
    }

    /** Ends the login session that is not needed after the device registration (SYNC_API §2.1 step 5). */
    suspend fun endSession(origin: HttpUrl, refreshToken: String) {
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(origin.newBuilder().encodedPath("/api/auth/logout").build())
                .header("Cookie", "synclet_refresh=$refreshToken")
                .post(ByteArray(0).toRequestBody(null)).build()
            try {
                noRedirects.newBuilder().callTimeout(5, TimeUnit.SECONDS).build().newCall(request).await().close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // best effort: the session expires on its own after 30 days
            }
        }
    }

    companion object {
        const val CLIENT_ID = "android"
        const val REDIRECT_URI = "synclet://oauth"
        private val JSON = "application/json; charset=utf-8".toMediaType()

        /** `code` of the redirect, after checking `state` (first, so a forged redirect never yields anything). */
        fun codeFromRedirect(redirect: String, expectedState: String): String {
            val uri = try { URI(redirect) } catch (e: URISyntaxException) { throw LoginError.MissingCode }
            if (uri.scheme != "synclet" || uri.host != "oauth" || uri.rawUserInfo != null ||
                uri.port != -1 || !uri.rawPath.isNullOrEmpty()
            ) throw LoginError.MissingCode
            val params = try {
                (uri.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate { pair ->
                    val i = pair.indexOf('=')
                    val key = if (i < 0) pair else pair.substring(0, i)
                    val value = if (i < 0) "" else pair.substring(i + 1)
                    URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
                }
            } catch (e: IllegalArgumentException) {
                throw LoginError.MissingCode
            }
            if (params["state"] != expectedState) throw LoginError.StateMismatch
            params["error"]?.let { throw LoginError.Denied(it) }
            return params["code"]?.takeIf { it.isNotEmpty() } ?: throw LoginError.MissingCode
        }
    }
}
