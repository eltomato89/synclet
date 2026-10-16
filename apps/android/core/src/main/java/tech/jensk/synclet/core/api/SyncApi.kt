package tech.jensk.synclet.core.api

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Sync API v1 client of one account (SYNC_API.md). Every call needs a token from [tokens]. */
class SyncApi(val origin: HttpUrl, val client: OkHttpClient, val tokens: TokenSource) {

    fun apiUrl(vararg segments: String): HttpUrl.Builder {
        val builder = origin.newBuilder().encodedPath("/").query(null).fragment(null).addPathSegment("api")
        segments.forEach { builder.addPathSegment(it) }
        return builder
    }

    fun syncUrl(vararg segments: String): HttpUrl.Builder = apiUrl("sync", "v1", *segments)

    fun resolve(pathOrUrl: String): HttpUrl =
        origin.resolve(pathOrUrl) ?: throw SyncError.InvalidResponse("not a URL: $pathOrUrl")

    fun currentToken(): String? = tokens.token()

    internal suspend fun send(builder: Request.Builder, accept: (Int) -> Boolean = { it in 200..299 }): Response =
        withContext(Dispatchers.IO) {
            val token = tokens.token() ?: throw SyncError.SignInRequired()
            val request = builder.header("Authorization", "Bearer $token").build()
            if (!sameOrigin(request.url, origin)) {
                throw SyncError.InvalidResponse("refusing to send the token to ${request.url.host}")
            }
            val response = try {
                client.newCall(request).await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                throw SyncError.Transport(e)
            }
            if (accept(response.code)) return@withContext response
            val error = response.use { errorFrom(it) }
            if (error.status == 401) tokens.onUnauthorized(token, error)
            throw error
        }

    internal suspend fun <T> json(builder: Request.Builder, deserializer: DeserializationStrategy<T>): T =
        withContext(Dispatchers.IO) {
            send(builder.header("Accept", "application/json")).use { response ->
                val text = try { response.body.string() } catch (e: IOException) { throw SyncError.Transport(e) }
                try {
                    SyncJson.decodeFromString(deserializer, text)
                } catch (e: SerializationException) {
                    throw SyncError.InvalidResponse("unexpected JSON from ${response.request.url.encodedPath}", e)
                } catch (e: IllegalArgumentException) {
                    throw SyncError.InvalidResponse("unexpected JSON from ${response.request.url.encodedPath}", e)
                }
            }
        }

    internal fun jsonBody(value: JsonElement): RequestBody =
        SyncJson.encodeToString(JsonElement.serializer(), value).toRequestBody(JSON)

    private fun get(url: HttpUrl) = Request.Builder().url(url).get()

    suspend fun account(): SyncAccount = json(get(syncUrl("account").build()), SyncAccount.serializer())

    suspend fun capabilities(): ServerCapabilities = try {
        json(get(syncUrl("capabilities").build()), ServerCapabilities.serializer())
    } catch (e: SyncError.Http) {
        if (e.status == 404 && e.code == null) ServerCapabilities() else throw e
    }

    suspend fun item(id: String): SyncItem = json(get(syncUrl("items", id).build()), SyncItem.serializer())

    suspend fun children(id: String, pageToken: String? = null, limit: Int? = null, folderThumbnails: Boolean = false): ChildrenPage {
        val url = syncUrl("items", id, "children").apply {
            pageToken?.let { addQueryParameter("pageToken", it) }
            limit?.let { addQueryParameter("limit", it.toString()) }
            if (folderThumbnails) addQueryParameter("folderThumbnails", "1")
        }.build()
        return json(get(url), ChildrenPage.serializer())
    }

    suspend fun allChildren(id: String, folderThumbnails: Boolean = false): List<SyncItem> {
        val all = ArrayList<SyncItem>()
        var token: String? = null
        do {
            val page = children(id, token, 1000, folderThumbnails)
            all += page.items
            token = page.nextPageToken
        } while (token != null)
        return all
    }

    suspend fun cursor(space: String): String =
        json(get(syncUrl("cursor").addQueryParameter("space", space).build()), CursorResponse.serializer()).cursor

    suspend fun changes(space: String, cursor: String, limit: Int? = null): ChangesPage {
        val url = syncUrl("changes").addQueryParameter("space", space).addQueryParameter("cursor", cursor)
            .apply { limit?.let { addQueryParameter("limit", it.toString()) } }.build()
        return json(get(url), ChangesPage.serializer())
    }

    suspend fun createFolder(parentId: String, name: String, onConflict: OnConflict = OnConflict.FAIL): SyncItem {
        val body = SyncJson.encodeToString(CreateFolderRequest.serializer(),
            CreateFolderRequest(parentId = parentId, name = name, onConflict = onConflict.wire)).toRequestBody(JSON)
        return json(Request.Builder().url(syncUrl("items").build()).post(body), SyncItem.serializer())
    }

    suspend fun patchItem(id: String, name: String? = null, parentId: String? = null, ifMatch: String? = null): SyncItem {
        val payload = buildJsonObject {
            name?.let { put("name", it) }
            parentId?.let { put("parentId", it) }
        }
        val builder = Request.Builder().url(syncUrl("items", id).build()).patch(jsonBody(payload))
        ifMatch?.let { builder.header("If-Match", quoteEtag(it)) }
        return json(builder, SyncItem.serializer())
    }

    suspend fun deleteItem(id: String, ifMatch: String? = null) {
        val builder = Request.Builder().url(syncUrl("items", id).build()).delete()
        ifMatch?.let { builder.header("If-Match", quoteEtag(it)) }
        send(builder).close()
    }

    suspend fun uploadNew(
        parentId: String, name: String, file: File, onConflict: OnConflict = OnConflict.RENAME,
        modifiedAt: String? = null, onProgress: (Long) -> Unit = {},
    ): SyncItem {
        val url = syncUrl("items", "upload").addQueryParameter("parentId", parentId)
            .addQueryParameter("name", name).addQueryParameter("onConflict", onConflict.wire).build()
        val builder = Request.Builder().url(url).post(FileRangeBody(file, type = OCTET_STREAM, onProgress = onProgress))
        modifiedAt?.let { builder.header("X-Synclet-Modified-At", it) }
        return json(builder, SyncItem.serializer())
    }

    suspend fun replaceContent(
        id: String, file: File, ifMatch: String, modifiedAt: String? = null, onProgress: (Long) -> Unit = {},
    ): SyncItem {
        val builder = Request.Builder().url(syncUrl("items", id, "content").build())
            .put(FileRangeBody(file, type = OCTET_STREAM, onProgress = onProgress))
            .header("If-Match", quoteEtag(ifMatch))
        modifiedAt?.let { builder.header("X-Synclet-Modified-At", it) }
        return json(builder, SyncItem.serializer())
    }

    /**
     * Downloads the content into [destination]. With [ifRange] (the content etag) and an existing,
     * non-empty [destination] the download resumes (`Range` + `If-Range`); a `200` rewrites the file.
     * Returns the final size.
     */
    suspend fun download(
        id: String, destination: File, ifRange: String? = null, onProgress: (Long, Long?) -> Unit = { _, _ -> },
    ): Long = withContext(Dispatchers.IO) {
        val start = if (ifRange != null && destination.exists()) destination.length() else 0L
        if (start == 0L) destination.delete()
        destination.parentFile?.mkdirs()
        val builder = get(syncUrl("items", id, "content").build())
        if (start > 0) builder.header("Range", "bytes=$start-").header("If-Range", quoteEtag(ifRange!!))
        val response = try {
            send(builder)
        } catch (e: SyncError.Http) {
            if (e.status == 416 && start > 0) {
                destination.delete()
                return@withContext download(id, destination, ifRange, onProgress)
            }
            throw e
        }
        if (response.code == 206 && start > 0 && contentRangeStart(response.header("Content-Range")) != start) {
            // Not the continuation of the local part (or no usable Content-Range): appending would corrupt the file.
            response.close()
            destination.delete()
            return@withContext download(id, destination, ifRange = null, onProgress = onProgress)
        }
        response.use { r ->
            val append = r.code == 206
            val total = if (append) r.header("Content-Range")?.substringAfterLast('/')?.toLongOrNull()
                        else r.body.contentLength().takeIf { it >= 0 }
            var written = if (append) start else 0L
            try {
                FileOutputStream(destination, append).use { out ->
                    val input = r.body.byteStream()
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        ensureActive()
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        written += n
                        onProgress(written, total)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                throw SyncError.Transport(e)
            }
            written
        }
    }

    suspend fun downloadToken(id: String, purpose: String = "download"): DownloadToken {
        val url = syncUrl("items", id, "download-token").addQueryParameter("purpose", purpose).build()
        return json(Request.Builder().url(url).post(ByteArray(0).toRequestBody(null)), DownloadToken.serializer())
    }

    fun thumbnailUrl(id: String, size: Int = 256, composite: Boolean = false): HttpUrl =
        syncUrl("items", id, "thumbnail").addQueryParameter("size", size.toString())
            .apply { if (composite) addQueryParameter("composite", "1") }.build()

    suspend fun registerDevice(request: RegisterDeviceRequest): DeviceRegistration {
        val body = SyncJson.encodeToString(RegisterDeviceRequest.serializer(), request).toRequestBody(JSON)
        return json(Request.Builder().url(syncUrl("devices").build()).post(body), DeviceRegistration.serializer())
    }

    suspend fun devices(): List<SyncDevice> = json(get(syncUrl("devices").build()), ListSerializer(SyncDevice.serializer()))

    suspend fun revokeCurrentDevice() {
        send(Request.Builder().url(syncUrl("devices", "current").build()).delete()).close()
    }

    fun eventsRequest(): SignedRequest? {
        val token = tokens.token() ?: return null
        val request = get(syncUrl("events").build())
            .header("Accept", "text/event-stream")
            .header("Authorization", "Bearer $token")
            .build()
        return SignedRequest(request, token)
    }

    companion object {
        /** First byte of `Content-Range: bytes <start>-<end>/<total>`, or null when the header is missing or malformed. */
        internal fun contentRangeStart(header: String?): Long? {
            val match = CONTENT_RANGE.matchEntire(header?.trim() ?: return null) ?: return null
            return match.groupValues[1].toLongOrNull()
        }
        private val CONTENT_RANGE = Regex("""bytes\s+(\d+)-(\d+)/(\d+|\*)""", RegexOption.IGNORE_CASE)
        private val JSON = "application/json; charset=utf-8".toMediaType()
        val OCTET_STREAM = "application/octet-stream".toMediaType()

        fun errorFrom(response: Response): SyncError.Http {
            val text = try { response.body.string() } catch (e: IOException) { "" }
            val parsed = try { SyncJson.decodeFromString(ErrorBody.serializer(), text) } catch (e: Exception) { null }
            val retryAfter = response.header("Retry-After")?.trim()?.toLongOrNull()
            return SyncError.Http(response.code, parsed?.code, parsed?.message ?: text.take(300).ifBlank { null },
                parsed?.item, retryAfter)
        }

        fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
            a.scheme == b.scheme && a.host.equals(b.host, ignoreCase = true) && a.port == b.port

        fun quoteEtag(etag: String): String =
            if (etag == "*" || etag.startsWith("\"") || etag.startsWith("W/")) etag else "\"$etag\""
    }
}
