package tech.jensk.synclet.core.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tech.jensk.synclet.core.testing.D1
import tech.jensk.synclet.core.testing.F1
import tech.jensk.synclet.core.testing.itemJson

class ModelsTest {
    @Test fun itemWithoutPreviewOrSpaceIsPersonalWithoutThumbnail() {
        val item = SyncJson.decodeFromString(SyncItem.serializer(), itemJson(F1, "a.txt"))
        assertEquals(SyncSpace.PERSONAL, item.space)
        assertEquals("personal", item.space)
        assertFalse(item.hasThumbnail)
        assertNull(item.preview)
        assertFalse(item.isFolder)
        assertFalse(item.isSpaceRoot)
    }

    @Test fun folderPreviewCarriesThumbnailKey() {
        val key = "0123456789abcdef".repeat(4)
        val json = itemJson(D1, "Photos", extra = ""","preview":{"kind":"none","thumbnail":true,"thumbnailKey":"$key"}""")
        val item = SyncJson.decodeFromString(SyncItem.serializer(), json)
        assertTrue(item.isFolder)
        assertTrue(item.hasThumbnail)
        assertEquals("none", item.preview?.kind)
        assertEquals(key, item.preview?.thumbnailKey)
    }

    @Test fun createShareLinkOmitsNullsAndEncodesDefaults() {
        val encoded = SyncJson.encodeToString(CreateShareLink.serializer(), CreateShareLink(itemId = F1))
        assertEquals("""{"itemId":"$F1","allowDownload":true,"allowUpload":false}""", encoded)
    }

    @Test fun spaceRootIds() {
        assertEquals("root", SyncSpace.rootIdOf("personal"))
        assertEquals(SyncItem.ROOT_ID, SyncSpace.rootIdOf(SyncSpace.PERSONAL))
        assertEquals("r_6f1c0000-0000-0000-0000-000000000000", SyncSpace.rootIdOf("6f1c0000-0000-0000-0000-000000000000"))
    }

    @Test fun deleteChangeExposesItemId() {
        val change = SyncJson.decodeFromString(SyncChange.serializer(), """{"op":"delete","id":"$F1"}""")
        assertEquals("delete", change.op)
        assertNull(change.item)
        assertEquals(F1, change.itemId)
        val upsert = SyncJson.decodeFromString(SyncChange.serializer(), """{"op":"upsert","item":${itemJson(D1, "Docs")}}""")
        assertEquals(D1, upsert.itemId)
    }
}
