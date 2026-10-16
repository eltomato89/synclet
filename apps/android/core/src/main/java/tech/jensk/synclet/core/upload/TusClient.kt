package tech.jensk.synclet.core.upload

import java.io.File
import java.io.IOException
import java.util.Base64
import kotlinx.serialization.SerializationException
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import tech.jensk.synclet.core.api.FileRangeBody
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson

sealed interface TusTarget {
    data class Create(val name: String, val parentId: String) : TusTarget
    data class Replace(val itemId: String, val ifMatch: String) : TusTarget
}
sealed interface TusCreated {
    data class Created(val url: HttpUrl) : TusCreated
    data class Completed(val item: SyncItem) : TusCreated
}
sealed interface TusPatchResult {
    data class Offset(val offset: Long) : TusPatchResult
    data class Completed(val item: SyncItem) : TusPatchResult
}

/** tus 1.0 against `<origin>/api/sync/v1/uploads` (SYNC_API §7). Stateless; the token never leaves the origin (SyncApi.send). */
class TusClient(private val api: SyncApi) {
    fun metadata(target: TusTarget, modifiedAt: String?): String {
        val pairs = when (target) {
            is TusTarget.Create -> listOf("name" to target.name, "parentId" to target.parentId, "onConflict" to "rename")
            is TusTarget.Replace -> listOf("itemId" to target.itemId, "ifMatch" to target.ifMatch.removePrefix("W/").trim('"'))
        } + listOfNotNull(modifiedAt?.let { "modifiedAt" to it })
        return pairs.joinToString(",") { (k, v) -> "$k ${Base64.getEncoder().encodeToString(v.toByteArray(Charsets.UTF_8))}" }
    }

    suspend fun create(length: Long, target: TusTarget, modifiedAt: String?): TusCreated {
        val builder = Request.Builder().url(api.syncUrl("uploads").build())
            .post(ByteArray(0).toRequestBody(null))
            .header("Tus-Resumable", "1.0.0")
            .header("Upload-Length", length.toString())
            .header("Upload-Metadata", metadata(target, modifiedAt))
        return api.send(builder).use { response ->
            if (response.code != 201) throw SyncError.InvalidResponse("tus: unexpected status ${response.code}")
            val location = response.header("Location") ?: throw SyncError.InvalidResponse("tus: Location missing")
            val url = api.origin.resolve(location) ?: throw SyncError.InvalidResponse("tus: bad Location")
            if (!SyncApi.sameOrigin(url, api.origin)) throw SyncError.InvalidResponse("tus: Location on another origin")
            if (length == 0L) TusCreated.Completed(published(response)) else TusCreated.Created(url)
        }
    }

    suspend fun head(url: HttpUrl): Long {
        val builder = Request.Builder().url(url).head().header("Tus-Resumable", "1.0.0")
        return api.send(builder).use { it.header("Upload-Offset")?.trim()?.toLongOrNull() }
            ?: throw SyncError.InvalidResponse("tus: Upload-Offset missing")
    }

    suspend fun patch(url: HttpUrl, offset: Long, file: File, length: Long, onProgress: (Long) -> Unit = {}): TusPatchResult {
        val builder = Request.Builder().url(url)
            .patch(FileRangeBody(file, offset, length, OFFSET_STREAM, onProgress))
            .header("Tus-Resumable", "1.0.0")
            .header("Upload-Offset", offset.toString())
        return api.send(builder).use { response ->
            when (response.code) {
                204 -> TusPatchResult.Offset(response.header("Upload-Offset")?.trim()?.toLongOrNull()
                    ?: throw SyncError.InvalidResponse("tus: Upload-Offset missing"))
                200, 201 -> TusPatchResult.Completed(published(response))
                else -> throw SyncError.InvalidResponse("tus: unexpected status ${response.code}")
            }
        }
    }

    suspend fun terminate(url: HttpUrl) {
        api.send(Request.Builder().url(url).delete().header("Tus-Resumable", "1.0.0")) { it in 200..299 || it == 404 || it == 410 }.close()
    }

    /** The completing request carries the SyncItem; otherwise `X-Synclet-Item` + GET (§7.4). */
    private suspend fun published(response: Response): SyncItem {
        val text = try { response.body.string() } catch (e: IOException) { throw SyncError.Transport(e) }
        if (text.isNotBlank()) {
            try { return SyncJson.decodeFromString(SyncItem.serializer(), text) } catch (e: SerializationException) { }
        }
        val id = response.header("X-Synclet-Item")?.takeIf { it.isNotBlank() }
            ?: throw SyncError.InvalidResponse("tus: completed upload without item")
        return api.item(id)
    }

    private companion object { val OFFSET_STREAM = "application/offset+octet-stream".toMediaType() }
}
