package tech.jensk.synclet.core.api

import java.time.Instant
import okhttp3.HttpUrl

object ShareLinks {
    /** `url` is `/s/<token>` unless the server has SYNCLET_PUBLIC_URL (SYNC_API §11a). */
    fun absoluteUrl(link: ShareLink, origin: HttpUrl): String =
        if (link.url.isEmpty()) "" else origin.resolve(link.url)?.toString() ?: link.url

    fun newestActive(links: List<ShareLink>, now: Instant): ShareLink? = links
        .filter { it.revokedAt == null && !it.itemTrashed }
        .filter { link -> link.expiresAt?.let { runCatching { Instant.parse(it) }.getOrNull()?.isAfter(now) ?: false } ?: true }
        .maxByOrNull { runCatching { Instant.parse(it.createdAt) }.getOrDefault(Instant.EPOCH) }
}
