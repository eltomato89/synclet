package tech.jensk.synclet.core.cache

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncJson
import tech.jensk.synclet.core.api.shortKey
import tech.jensk.synclet.core.testing.D1
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.itemJson

class ThumbnailCacheTest {
    private fun item(id: String, extra: String) =
        SyncJson.decodeFromString(SyncItem.serializer(), itemJson(id, "n", extra = extra))

    @Test fun fileKeyUsesSha256() {
        val i = item(F1, ""","preview":{"kind":"image","thumbnail":true}""").copy(sha256 = "abc")
        assertEquals("${shortKey("k")}/$F1/abc-256", ThumbnailCache.key("k", i, 256))
    }

    @Test fun fileWithoutThumbnailHasNoKey() {
        assertNull(ThumbnailCache.key("k", item(F1, ""","preview":{"kind":"text","thumbnail":false}"""), 256))
    }

    @Test fun folderMosaicKey() {
        val i = item(D1, ""","preview":{"kind":"folder","thumbnailKey":"mk"}""")
        assertEquals("${shortKey("k")}/$D1/m-mk-256", ThumbnailCache.key("k", i, 256))
        assertNull(ThumbnailCache.key("k", item(D1, ""), 256))
    }
}
