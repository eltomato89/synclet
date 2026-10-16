package tech.jensk.synclet.ui.preview

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.PreviewText
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.components.syncErrorMessage

@Composable
fun TextPage(vm: PreviewViewModel, item: SyncItem, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val result by produceState<Result<PreviewText>?>(null, item.id) { value = runCatching { vm.text(item) } }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val r = result
        when {
            r == null -> androidx.compose.material3.CircularProgressIndicator()
            r.isFailure -> Text(context.syncErrorMessage(r.exceptionOrNull()!!))
            else -> {
                val text = r.getOrThrow()
                Column(Modifier.fillMaxSize().padding(12.dp)) {
                    if (text.truncated) {
                        Text(stringResource(R.string.preview_truncated), style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                    }
                    SelectionContainer(Modifier.weight(1f)) {
                        Text(
                            text.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                            softWrap = false,
                            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()),
                        )
                    }
                }
            }
        }
    }
}
