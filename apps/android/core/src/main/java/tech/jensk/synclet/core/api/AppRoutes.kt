package tech.jensk.synclet.core.api

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

sealed interface Patch<out T> {
    data object Keep : Patch<Nothing>
    data class Set<T>(val value: T) : Patch<T>
}

/** `PATCH /shares/:id`: omitted = unchanged, `null` removes password / expiry (SYNC_API §11a). */
data class ShareLinkPatch(
    val password: Patch<String?> = Patch.Keep,
    val expiresAt: Patch<String?> = Patch.Keep,
    val allowDownload: Boolean? = null,
    val allowUpload: Boolean? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        (password as? Patch.Set)?.let { put("password", it.value?.let(::JsonPrimitive) ?: JsonNull) }
        (expiresAt as? Patch.Set)?.let { put("expiresAt", it.value?.let(::JsonPrimitive) ?: JsonNull) }
        allowDownload?.let { put("allowDownload", JsonPrimitive(it)) }
        allowUpload?.let { put("allowUpload", JsonPrimitive(it)) }
    }
}

private val EMPTY get() = ByteArray(0).toRequestBody(null)

suspend fun SyncApi.search(q: String, limit: Int = 20, offset: Int = 0, folder: String? = null, space: String? = null): SearchResponse {
    val url = syncUrl("search").addQueryParameter("q", q).addQueryParameter("limit", limit.toString())
        .addQueryParameter("offset", offset.toString())
        .apply { folder?.let { addQueryParameter("folder", it) }; space?.let { addQueryParameter("space", it) } }.build()
    return json(Request.Builder().url(url), SearchResponse.serializer())
}

suspend fun SyncApi.recent(limit: Int = 50, space: String? = null): List<SyncItem> {
    val url = syncUrl("recent").addQueryParameter("limit", limit.toString())
        .apply { space?.let { addQueryParameter("space", it) } }.build()
    return json(Request.Builder().url(url), ListSerializer(SyncItem.serializer()))
}

suspend fun SyncApi.previewText(id: String): PreviewText =
    json(Request.Builder().url(syncUrl("items", id, "preview-text").build()), PreviewText.serializer())

suspend fun SyncApi.trash(): List<TrashEntry> =
    json(Request.Builder().url(apiUrl("trash").build()), ListSerializer(TrashEntry.serializer()))

suspend fun SyncApi.restoreTrash(trashId: String): RestoreResult =
    json(Request.Builder().url(apiUrl("trash", trashId, "restore").build()).post(EMPTY), RestoreResult.serializer())

suspend fun SyncApi.deleteTrash(trashId: String) { send(Request.Builder().url(apiUrl("trash", trashId).build()).delete()).close() }

suspend fun SyncApi.emptyTrash(space: String): Int =
    json(Request.Builder().url(apiUrl("trash").addQueryParameter("space", space).build()).delete(), EmptyTrashResponse.serializer()).removed

suspend fun SyncApi.shareLinks(itemId: String? = null): List<ShareLink> {
    val url = apiUrl("shares").apply { itemId?.let { addQueryParameter("itemId", it) } }.build()
    return json(Request.Builder().url(url), ListSerializer(ShareLink.serializer()))
}

suspend fun SyncApi.createShareLink(request: CreateShareLink): ShareLink {
    val body = jsonBody(SyncJson.encodeToJsonElement(CreateShareLink.serializer(), request))
    return json(Request.Builder().url(apiUrl("shares").build()).post(body), ShareLink.serializer())
}

suspend fun SyncApi.patchShareLink(id: String, patch: ShareLinkPatch): ShareLink =
    json(Request.Builder().url(apiUrl("shares", id).build()).patch(jsonBody(patch.toJson())), ShareLink.serializer())

suspend fun SyncApi.rotateShareLink(id: String): ShareLink =
    json(Request.Builder().url(apiUrl("shares", id, "rotate").build()).post(EMPTY), ShareLink.serializer())

suspend fun SyncApi.deleteShareLink(id: String) { send(Request.Builder().url(apiUrl("shares", id).build()).delete()).close() }
