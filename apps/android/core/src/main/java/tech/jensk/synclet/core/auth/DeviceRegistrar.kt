package tech.jensk.synclet.core.auth

import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import tech.jensk.synclet.core.api.DeviceRegistration
import tech.jensk.synclet.core.api.FixedTokenSource
import tech.jensk.synclet.core.api.RegisterDeviceRequest
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.sha256Hex

class DeviceRegistrar(private val client: OkHttpClient) {
    suspend fun register(origin: HttpUrl, accessToken: String, name: String, installationId: String?, appVersion: String): DeviceRegistration =
        SyncApi(origin, client, FixedTokenSource(accessToken)).registerDevice(
            RegisterDeviceRequest(
                name = truncateUtf16(name.trim().ifEmpty { "Android" }, 100),
                platform = "android",
                appVersion = truncateUtf16(appVersion, 40),
                installationId = installationId,
            ),
        )

    companion object {
        /** Longest prefix of at most [max] UTF-16 units that does not split a surrogate pair (the server counts JS length). */
        fun truncateUtf16(text: String, max: Int): String {
            if (text.length <= max) return text
            var end = max
            if (Character.isHighSurrogate(text[end - 1])) end--
            return text.substring(0, end)
        }

        /** SHA-256 of `Settings.Secure.ANDROID_ID` (SYNC_API §2.2); re-registering revokes this installation's older devices. */
        fun installationId(androidId: String?): String? = androidId?.takeIf { it.isNotBlank() }?.let(::sha256Hex)
    }
}
