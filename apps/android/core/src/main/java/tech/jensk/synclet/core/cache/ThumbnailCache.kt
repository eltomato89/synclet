package tech.jensk.synclet.core.cache

import android.content.Context
import coil3.ImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import java.io.File
import okhttp3.OkHttpClient
import okio.Path.Companion.toOkioPath
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.shortKey

/**
 * Server thumbnails through one Coil ImageLoader (disk cache 200 MB). Keys contain sha256 (files) or
 * thumbnailKey (folder mosaics), so a changed picture always has a new key (Spec-Klärung 11).
 */
object ThumbnailCache {
    fun newImageLoader(context: Context, client: OkHttpClient, dir: File, maxBytes: Long = 200L shl 20): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { client })) }
            .diskCache { DiskCache.Builder().directory(dir.toOkioPath()).maxSizeBytes(maxBytes).build() }
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.15).build() }
            .build()

    fun key(accountKey: String, item: SyncItem, size: Int): String? = when {
        item.isFolder -> item.preview?.thumbnailKey?.let { "${shortKey(accountKey)}/${item.id}/m-$it-$size" }
        item.hasThumbnail -> "${shortKey(accountKey)}/${item.id}/${item.sha256 ?: item.contentEtag ?: item.etag}-$size"
        else -> null
    }

    fun request(context: Context, api: SyncApi, accountKey: String, item: SyncItem, size: Int = 256): ImageRequest? {
        val key = key(accountKey, item, size) ?: return null
        val token = api.currentToken() ?: return null
        return ImageRequest.Builder(context)
            .data(api.thumbnailUrl(item.id, size, composite = item.isFolder).toString())
            .httpHeaders(NetworkHeaders.Builder().set("Authorization", "Bearer $token").build())
            .memoryCacheKey(key)
            .diskCacheKey(key)
            .build()
    }

    /** The cached thumbnail file for the provider (downloads it first if needed); null when there is none. */
    suspend fun file(context: Context, loader: ImageLoader, api: SyncApi, accountKey: String, item: SyncItem, size: Int = 256): File? {
        val base = request(context, api, accountKey, item, size) ?: return null
        val key = base.diskCacheKey ?: return null
        val disk = loader.diskCache ?: return null
        disk.openSnapshot(key)?.use { return it.data.toFile() }
        val result = loader.execute(base.newBuilder().memoryCachePolicy(CachePolicy.DISABLED).build())
        if (result !is SuccessResult) return null
        return disk.openSnapshot(key)?.use { it.data.toFile() }
    }
}
