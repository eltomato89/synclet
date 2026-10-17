package tech.jensk.synclet.core.account

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AppSettingsTest {
    @get:Rule val tmp = TemporaryFolder()
    private val scope = CoroutineScope(Dispatchers.IO + Job())
    @After fun tearDown() { scope.cancel() }
    private fun settings() = AppSettings(PreferenceDataStoreFactory.create(scope = scope, produceFile = { File(tmp.root, "settings.preferences_pb") }))

    @Test fun defaults() = runBlocking {
        val s = settings()
        assertEquals(ViewMode.LIST, s.viewMode.first())
        assertEquals(SortOrder(), s.sortOrder.first())
        assertNull(s.selectedAccount.first())
        assertNull(s.lastShareTarget.first())
    }

    @Test fun roundTrips() = runBlocking {
        val s = settings()
        s.setViewMode(ViewMode.GRID); s.setSortOrder(SortOrder(SortField.SIZE, false)); s.setSelectedAccount("a")
        val target = ShareTarget("a", "d_1", "Docs")
        s.setLastShareTarget(target)
        assertEquals(ViewMode.GRID, s.viewMode.first())
        assertEquals(SortOrder(SortField.SIZE, false), s.sortOrder.first())
        assertEquals("a", s.selectedAccount.first())
        assertEquals(target, s.lastShareTarget.first())
        s.setSelectedAccount(null)
        assertNull(s.selectedAccount.first())
    }

    @Test fun clearingShareTarget() = runBlocking {
        val s = settings()
        s.setLastShareTarget(ShareTarget("a", "d_1", "Docs"))
        s.setLastShareTarget(null)
        assertNull(s.lastShareTarget.first())
    }
}
