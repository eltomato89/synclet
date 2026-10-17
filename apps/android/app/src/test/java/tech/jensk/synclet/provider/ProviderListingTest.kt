package tech.jensk.synclet.provider

import android.content.Context
import android.os.Bundle
import android.webkit.MimeTypeMap
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import tech.jensk.synclet.R
import tech.jensk.synclet.testing.D1
import tech.jensk.synclet.testing.F1
import tech.jensk.synclet.testing.F2
import tech.jensk.synclet.testing.error
import tech.jensk.synclet.testing.fileItem
import tech.jensk.synclet.testing.folderItem
import tech.jensk.synclet.testing.itemJson
import tech.jensk.synclet.testing.json

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProviderListingTest : ProviderTestBase() {

    @Test fun rootsOnePerAccountWithSummaryAndFlags() {
        provider.queryRoots(null).use { c ->
            assertEquals(1, c.count); c.moveToFirst()
            assertEquals("srv:u1", c.getString(c.getColumnIndexOrThrow(Root.COLUMN_ROOT_ID)))
            assertEquals("srv:u1/top", c.getString(c.getColumnIndexOrThrow(Root.COLUMN_DOCUMENT_ID)))
            assertEquals(env.account.title, c.getString(c.getColumnIndexOrThrow(Root.COLUMN_SUMMARY)))
            val flags = c.getInt(c.getColumnIndexOrThrow(Root.COLUMN_FLAGS))
            for (f in listOf(Root.FLAG_SUPPORTS_CREATE, Root.FLAG_SUPPORTS_SEARCH, Root.FLAG_SUPPORTS_RECENTS, Root.FLAG_SUPPORTS_IS_CHILD))
                assertTrue(flags and f != 0)
        }
    }

    @Test fun topLevelListsSpacesWithoutNetwork() {
        provider.queryChildDocuments("srv:u1/top", null, null as String?).use { c ->
            assertEquals(listOf("srv:u1/root", "srv:u1/r_$TEAM_ID", "srv:u1/r_$NAS_ID"), ids(c))
            assertEquals("My Files", names(c).first())
            assertTrue(flagsOf(c, "srv:u1/r_$TEAM_ID") and Document.FLAG_DIR_SUPPORTS_CREATE != 0)
            assertEquals(0, flagsOf(c, "srv:u1/r_$NAS_ID") and Document.FLAG_DIR_SUPPORTS_CREATE)   // missing space
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun spaceRootDocumentWithoutNetwork() {
        provider.queryDocument("srv:u1/root", null).use { c ->
            assertEquals(listOf("srv:u1/root"), ids(c))
            assertEquals(listOf("My Files"), names(c))
        }
        provider.queryDocument("srv:u1/top", null).use { c -> assertEquals(listOf("srv:u1/top"), ids(c)) }
        assertEquals(0, server.requestCount)
    }

    @Test fun firstQueryLoadsInTheBackgroundThenServesTheFreshListing() {
        server.json("""{"items":[${itemJson(folderItem(D1, "Docs"))},${itemJson(fileItem(F1, "a.txt"))}],"nextPageToken":null,"cursor":"1"}""")
        provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c ->
            assertEquals(0, c.count)
            assertTrue(c.extras.getBoolean(DocumentsContract.EXTRA_LOADING))
        }
        waitUntil { env.notifier.children.contains("srv:u1" to "root") }
        provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c ->
            assertEquals(listOf("Docs", "a.txt"), names(c))
            assertFalse(c.extras.getBoolean(DocumentsContract.EXTRA_LOADING))
            assertEquals("text/plain", c.apply { moveToPosition(1) }.getString(c.getColumnIndexOrThrow(Document.COLUMN_MIME_TYPE)))
        }
        assertEquals(1, server.requestCount)
    }

    @Test fun failedLoadReportsErrorWithoutReloadLoop() {
        server.error(500, null, "boom")
        provider.queryChildDocuments("srv:u1/root", null, null as String?).close()
        waitUntil { env.notifier.children.contains("srv:u1" to "root") }
        repeat(2) {
            provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c ->
                assertNotNull(c.extras.getString(DocumentsContract.EXTRA_ERROR))
                assertFalse(c.extras.getBoolean(DocumentsContract.EXTRA_LOADING))
            }
        }
        assertEquals(1, server.requestCount)
        assertEquals(1, env.notifier.children.size)
    }

    @Test fun failedLoadIsRetriedAfterThirtySeconds() {
        server.error(500, null, "boom")
        provider.queryChildDocuments("srv:u1/root", null, null as String?).close()
        waitUntil { env.notifier.children.size == 1 }
        env.now += 30_001
        server.json("""{"items":[${itemJson(fileItem(F1, "a.txt"))}],"nextPageToken":null,"cursor":"1"}""")
        provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c ->
            assertTrue(c.extras.getBoolean(DocumentsContract.EXTRA_LOADING))
        }
        waitUntil { env.notifier.children.size == 2 }
        provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c -> assertEquals(listOf("a.txt"), names(c)) }
    }

    @Test fun staleListingIsShownWhileReloading() {
        env.listingCache.put("srv:u1", "root", listOf(fileItem(F1, "old.txt")))
        env.now += 31_000
        server.json("""{"items":[${itemJson(fileItem(F1, "new.txt"))}],"nextPageToken":null,"cursor":"1"}""")
        provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c ->
            assertEquals(listOf("old.txt"), names(c))
            assertTrue(c.extras.getBoolean(DocumentsContract.EXTRA_LOADING))
        }
        waitUntil { env.notifier.children.contains("srv:u1" to "root") }
        provider.queryChildDocuments("srv:u1/root", null, null as String?).use { c ->
            assertEquals(listOf("new.txt"), names(c))
            assertFalse(c.extras.getBoolean(DocumentsContract.EXTRA_LOADING))
        }
    }

    @Test fun searchUsesServerSearch() {
        server.json("""{"hits":[{"item":${itemJson(fileItem(F1, "report.txt"))},"path":"/report.txt","matched":"name"}],"total":1}""")
        provider.querySearchDocuments("srv:u1", "rep", null).use { c ->
            assertEquals(listOf("srv:u1/$F1"), ids(c))
            assertEquals(listOf("report.txt"), names(c))
        }
        assertTrue(server.takeRequest().path!!.startsWith("/api/sync/v1/search?q=rep&limit=50"))
    }

    @Test fun bundleSearchUsesTheDisplayNameAndFiltersMimeTypes() {
        shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("jpg", "image/jpeg")
        val hits = listOf(fileItem(F1, "report.txt"), fileItem(F2, "photo.jpg"), folderItem(D1, "reports"))
            .joinToString(",") { """{"item":${itemJson(it)},"path":"/${it.name}","matched":"name"}""" }
        server.json("""{"hits":[$hits],"total":3}""")
        val args = Bundle().apply {
            putString(DocumentsContract.QUERY_ARG_DISPLAY_NAME, "rep")
            putStringArray(DocumentsContract.QUERY_ARG_MIME_TYPES, arrayOf("image/*"))
        }
        provider.querySearchDocuments("srv:u1", null, args)!!.use { c -> assertEquals(listOf("photo.jpg"), names(c)) }
        assertTrue(server.takeRequest().path!!.startsWith("/api/sync/v1/search?q=rep&limit=50"))
    }

    @Test fun bundleSearchWithoutAMimeFilterKeepsEverythingAndNullArgsAreSafe() {
        server.json("""{"hits":[{"item":${itemJson(fileItem(F1, "report.txt"))},"path":"/report.txt","matched":"name"}],"total":1}""")
        val args = Bundle().apply { putString(DocumentsContract.QUERY_ARG_DISPLAY_NAME, "rep") }
        provider.querySearchDocuments("srv:u1", null, args)!!.use { c -> assertEquals(listOf("report.txt"), names(c)) }
        provider.querySearchDocuments("srv:u1", null, null as Bundle?)!!.use { c -> assertEquals(0, c.count) }
        provider.querySearchDocuments("srv:u1", null, Bundle())!!.use { c -> assertEquals(0, c.count) }
        assertEquals(1, server.requestCount)                // no search without a term
    }

    @Test fun failedSearchReportsALocalizedError() {
        server.error(503, "space_unavailable")
        provider.querySearchDocuments("srv:u1", "rep", null).use { c ->
            assertEquals(0, c.count)
            val context = ApplicationProvider.getApplicationContext<Context>()
            assertEquals(context.getString(R.string.error_space_unavailable), c.extras.getString(DocumentsContract.EXTRA_ERROR))
        }
    }

    @Test fun recentUsesServerRecent() {
        server.json("[${itemJson(fileItem(F1, "a.txt"))}]")
        provider.queryRecentDocuments("srv:u1", null).use { c -> assertEquals(listOf("a.txt"), names(c)) }
        assertTrue(server.takeRequest().path!!.startsWith("/api/sync/v1/recent?limit=64"))
    }

    @Test fun isChildAndPathWalkParents() {
        server.json(itemJson(fileItem(F1, "a.txt", parentId = D1)))
        server.json(itemJson(folderItem(D1, "Docs", parentId = "root")))
        assertTrue(provider.isChildDocument("srv:u1/root", "srv:u1/$F1"))
        assertTrue(provider.isChildDocument("srv:u1/top", "srv:u1/$F1"))
        assertFalse(provider.isChildDocument("srv:u1/r_$TEAM_ID", "srv:u1/$F1"))
        val path = provider.findDocumentPath(null, "srv:u1/$F1")
        assertEquals("srv:u1", path.rootId)
        assertEquals(listOf("srv:u1/top", "srv:u1/root", "srv:u1/$D1", "srv:u1/$F1"), path.path)
        val relative = provider.findDocumentPath("srv:u1/$D1", "srv:u1/$F1")
        assertEquals(listOf("srv:u1/$D1", "srv:u1/$F1"), relative.path)
        assertEquals(2, server.requestCount)          // stops at the space root
    }
}
