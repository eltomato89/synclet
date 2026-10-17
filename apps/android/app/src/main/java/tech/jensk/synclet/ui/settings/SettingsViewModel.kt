package tech.jensk.synclet.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class SettingsViewModel(
    private val sizeBytes: () -> Long,
    private val clear: suspend () -> Unit,
) : ViewModel() {
    private val size = MutableStateFlow(0L)
    val cacheBytes: StateFlow<Long> = size.asStateFlow()

    init { refresh() }

    private fun refresh() = viewModelScope.launch { size.value = withContext(Dispatchers.IO) { sizeBytes() } }

    fun clearCache() = viewModelScope.launch {
        clear()
        size.value = withContext(Dispatchers.IO) { sizeBytes() }
    }
}
