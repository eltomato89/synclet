package tech.jensk.synclet.core.api

import java.time.Instant
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Test

class ShareLinksTest {
    private val origin = "https://files.example.com".toHttpUrl()
    private fun link(id: String, url: String = "/s/$id", created: String = "2026-10-01T00:00:00Z",
                     expires: String? = null, revoked: String? = null, trashed: Boolean = false) =
        ShareLink(id, "i", "n", "file", url, false, expires, true, false, created, revoked, 0, trashed)

    @Test fun absoluteUrl() {
        assertEquals("https://files.example.com/s/tok", ShareLinks.absoluteUrl(link("tok", "/s/tok"), origin))
        assertEquals("https://other.example/s/x", ShareLinks.absoluteUrl(link("x", "https://other.example/s/x"), origin))
    }

    @Test fun newestActiveIgnoresInactive() {
        val now = Instant.parse("2026-10-16T00:00:00Z")
        val links = listOf(
            link("old", created = "2026-10-01T00:00:00Z"),
            link("new", created = "2026-10-10T00:00:00Z"),
            link("trashed", created = "2026-10-15T00:00:00Z", trashed = true),
            link("expired", created = "2026-10-14T00:00:00Z", expires = "2026-10-15T00:00:00Z"),
            link("revoked", created = "2026-10-13T00:00:00Z", revoked = "2026-10-14T00:00:00Z"),
        )
        assertEquals("new", ShareLinks.newestActive(links, now)?.id)
    }
}
