package tech.jensk.synclet.ui.settings

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import tech.jensk.synclet.testing.MainDispatcherRule

class SettingsViewModelTest {
    @get:Rule val main = MainDispatcherRule()

    @Test fun cacheBytesReadsTheSize() = runBlocking {
        val vm = SettingsViewModel({ 1234L }, { })
        assertEquals(1234L, withTimeout(5_000) { vm.cacheBytes.first { it == 1234L } })
    }

    @Test fun clearCacheCallsClearAndRefreshesTheSize() = runBlocking {
        var size = 500L
        var cleared = 0
        val vm = SettingsViewModel({ size }, { cleared++; size = 0 })
        withTimeout(5_000) { vm.cacheBytes.first { it == 500L } }
        vm.clearCache().join()
        assertEquals(1, cleared)
        assertEquals(0L, withTimeout(5_000) { vm.cacheBytes.first { it == 0L } })
    }
}
