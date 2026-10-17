package tech.jensk.synclet.core.testing

import java.util.concurrent.CopyOnWriteArrayList
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.TokenSource

const val F1 = "f_11111111-1111-1111-1111-111111111111"
const val F2 = "f_22222222-2222-2222-2222-222222222222"
const val D1 = "d_33333333-3333-3333-3333-333333333333"
const val D2 = "d_44444444-4444-4444-4444-444444444444"

fun MockWebServer.json(body: String, code: Int = 200, headers: Map<String, String> = emptyMap()) {
    val response = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
    headers.forEach { (k, v) -> response.setHeader(k, v) }
    enqueue(response)
}

fun MockWebServer.error(code: Int, errorCode: String?, message: String = "error", itemJson: String? = null) =
    json(buildString {
        append("{\"statusCode\":$code,\"message\":\"$message\"")
        if (errorCode != null) append(",\"code\":\"$errorCode\"")
        if (itemJson != null) append(",\"item\":$itemJson")
        append('}')
    }, code)

/** A SyncItem as the server serialises it (all required fields, plus [extra] JSON members). */
fun itemJson(
    id: String, name: String, type: String = if (id.startsWith("d_") || id == "root" || id.startsWith("r_")) "folder" else "file",
    parentId: String? = "root", version: Long = 1, size: Long = 5, extra: String = "",
): String {
    val file = type == "file"
    val etag = if (file) "v$version" else "t00000000000000a1"
    val kind = if (id == "root" || id.startsWith("r_")) "root" else type
    val parent = parentId?.let { "\"$it\"" } ?: "null"
    return """{"id":"$id","parentId":$parent,"type":"$type","kind":"$kind","name":"$name","size":${if (file) size else 0},""" +
        """"mime":${if (file) "\"text/plain\"" else "null"},"version":${if (file) version else "null"},"sha256":null,""" +
        """"etag":"$etag","contentEtag":${if (file) "\"$etag\"" else "null"},"createdAt":"2026-10-16T08:00:00.000Z",""" +
        """"modifiedAt":"2026-10-16T08:00:00.000Z","documentId":${if (file) "\"$id\"" else "null"},""" +
        """"capabilities":{"read":true,"write":true,"rename":${kind != "root"},"move":${kind != "root"},""" +
        """"delete":${kind != "root"},"addChildren":${!file}}$extra}"""
}

class RecordingTokens(@Volatile var value: String? = "syd_test") : TokenSource {
    val failures = CopyOnWriteArrayList<Pair<String, SyncError.Http>>()
    override fun token(): String? = value
    override fun onUnauthorized(sentToken: String, error: SyncError.Http) { failures += sentToken to error }
}

fun MockWebServer.api(tokens: TokenSource = RecordingTokens(), client: OkHttpClient = OkHttpClient()): SyncApi =
    SyncApi(url("/").newBuilder().encodedPath("/").build(), client, tokens)
