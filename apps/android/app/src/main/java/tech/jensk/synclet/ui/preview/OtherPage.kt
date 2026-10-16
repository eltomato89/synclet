package tech.jensk.synclet.ui.preview

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.components.formatBytes
import tech.jensk.synclet.ui.components.iconFor
import tech.jensk.synclet.ui.components.syncErrorMessage

@Composable
fun OtherPage(
    vm: PreviewViewModel, accountKey: String, item: SyncItem, onMessage: (String) -> Unit, modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val state by vm.state.collectAsStateWithLifecycle()
    var busy by remember(item.id) { mutableStateOf(false) }
    Column(
        modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
    ) {
        Icon(iconFor(item), null, Modifier.size(96.dp), tint = MaterialTheme.colorScheme.primary)
        Text(item.name, style = MaterialTheme.typography.titleMedium)
        Text(formatBytes(item.size), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (busy) {
            LoadingProgress(state.progress[item.id])
        } else {
            Button(onClick = {
                busy = true
                scope.launch {
                    try {
                        vm.original(item)
                        if (!openWith(context, accountKey, item)) onMessage(context.getString(R.string.preview_no_app))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        onMessage(context.syncErrorMessage(e))
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(R.string.preview_open_with)) }
        }
    }
}
