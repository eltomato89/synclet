package tech.jensk.synclet.testing

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import tech.jensk.synclet.core.api.Capabilities
import tech.jensk.synclet.core.api.FixedTokenSource
import tech.jensk.synclet.core.api.PreviewInfo
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.api.TokenSource

const val F1 = "f_11111111-1111-1111-1111-111111111111"
const val F2 = "f_22222222-2222-2222-2222-222222222222"
const val D1 = "d_33333333-3333-3333-3333-333333333333"
const val D2 = "d_44444444-4444-4444-4444-444444444444"

private const val STAMP = "2026-10-16T08:00:00.000Z"

fun fileItem(
    id: String, name: String, parentId: String = "root", version: Long = 1, size: Long = 5, kind: String = "text",
    thumbnail: Boolean = false, spaceId: String? = null, canWrite: Boolean = true,
): SyncItem = SyncItem(
    id = id, parentId = parentId, type = "file", kind = kind, name = name, size = size, mime = "text/plain",
    version = version, sha256 = "sha-$id-$version", etag = "v$version", contentEtag = "v$version",
    createdAt = STAMP, modifiedAt = STAMP, documentId = id,
    capabilities = Capabilities(read = true, write = canWrite, rename = canWrite, move = canWrite, delete = canWrite, addChildren = false),
    preview = PreviewInfo(kind = kind, thumbnail = thumbnail), spaceId = spaceId,
)

fun folderItem(id: String, name: String, parentId: String? = "root", spaceId: String? = null, canWrite: Boolean = true): SyncItem {
    val root = id == "root" || id.startsWith("r_")
    return SyncItem(
        id = id, parentId = parentId, type = "folder", kind = if (root) "root" else "folder", name = name, size = 0,
        etag = "t00000000000000a1", createdAt = STAMP, modifiedAt = STAMP,
        capabilities = Capabilities(read = true, write = canWrite, rename = canWrite && !root, move = canWrite && !root,
            delete = canWrite && !root, addChildren = canWrite),
        spaceId = spaceId,
    )
}

fun MockWebServer.json(body: String, code: Int = 200) {
    enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body))
}

fun MockWebServer.error(code: Int, errorCode: String?, message: String = "error", item: SyncItem? = null) =
    json(buildString {
        append("{\"statusCode\":$code,\"message\":\"$message\"")
        if (errorCode != null) append(",\"code\":\"$errorCode\"")
        if (item != null) append(",\"item\":${itemJson(item)}")
        append('}')
    }, code)

fun MockWebServer.api(tokens: TokenSource = FixedTokenSource("syd_test")): SyncApi =
    SyncApi(url("/").newBuilder().encodedPath("/").build(), okhttp3.OkHttpClient(), tokens)

fun itemJson(item: SyncItem): String = SyncJson.encodeToString(SyncItem.serializer(), item)
