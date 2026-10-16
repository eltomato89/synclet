package tech.jensk.synclet.ui.uploads

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.upload.TusClient
import tech.jensk.synclet.core.upload.UploadEntry
import tech.jensk.synclet.core.upload.UploadScheduler
import tech.jensk.synclet.core.upload.UploadStatus
import tech.jensk.synclet.ui.TestTags
import tech.jensk.synclet.ui.components.EmptyState
import tech.jensk.synclet.ui.components.formatBytes
import tech.jensk.synclet.ui.components.uploadFailureMessage

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UploadsScreen(graph: AppGraph, onBack: (() -> Unit)?) {
    val context = LocalContext.current.applicationContext
    val vm = viewModel {
        UploadsViewModel(
            graph.uploadQueue,
            schedule = { key, restart -> UploadScheduler.schedule(context, key, restart) },
            terminate = { e ->
                graph.session(e.accountKey)?.let { s ->
                    e.tusUrl?.toHttpUrlOrNull()?.let { TusClient(s.api).terminate(it) }
                }
            },
        )
    }
    val rows by vm.rows.collectAsStateWithLifecycle()
    var menu by remember { mutableStateOf(false) }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(stringResource(R.string.uploads_title)) },
            navigationIcon = {
                if (onBack != null) IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.shell_back))
                }
            },
            actions = {
                IconButton(onClick = { menu = true }) {
                    Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.uploads_menu))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.uploads_clear_done)) },
                        enabled = rows.any { it.status == UploadStatus.DONE },
                        onClick = { menu = false; vm.clearDone() },
                    )
                }
            },
        )
    }) { padding ->
        if (rows.isEmpty()) {
            EmptyState(stringResource(R.string.uploads_empty), Modifier.padding(padding))
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                items(rows, key = { it.id }) { entry ->
                    UploadRow(entry, onRetry = { vm.retry(entry) }, onRemove = { vm.remove(entry) })
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun UploadRow(entry: UploadEntry, onRetry: () -> Unit, onRemove: () -> Unit) {
    val context = LocalContext.current
    val target = entry.parentName.ifEmpty { stringResource(R.string.space_personal) }
    ListItem(
        modifier = Modifier.testTag(TestTags.uploadRow(entry.name)),
        headlineContent = { Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.uploads_to, target), style = MaterialTheme.typography.bodySmall, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                when (entry.status) {
                    UploadStatus.UPLOADING -> {
                        LinearProgressIndicator(
                            progress = { if (entry.size > 0) (entry.sent.toFloat() / entry.size).coerceIn(0f, 1f) else 0f },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(stringResource(R.string.uploads_progress, formatBytes(entry.sent), formatBytes(entry.size)),
                            style = MaterialTheme.typography.bodySmall)
                    }
                    UploadStatus.WAITING -> {
                        Text(stringResource(R.string.uploads_waiting), style = MaterialTheme.typography.bodySmall)
                        if (entry.attempts > 0) {
                            Text(entry.message ?: context.uploadFailureMessage(null), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    UploadStatus.FAILED -> {
                        Text(context.uploadFailureMessage(entry.failure), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error)
                        Row {
                            TextButton(onClick = onRetry) { Text(stringResource(R.string.uploads_retry)) }
                            TextButton(onClick = onRemove) { Text(stringResource(R.string.uploads_remove)) }
                        }
                    }
                    UploadStatus.DONE -> Text(
                        entry.conflictCopyName?.let { stringResource(R.string.uploads_conflict_copy, it) }
                            ?: stringResource(R.string.uploads_done),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        trailingContent = {
            if (entry.status == UploadStatus.UPLOADING || entry.status == UploadStatus.WAITING) {
                TextButton(onClick = onRemove) { Text(stringResource(R.string.uploads_cancel)) }
            }
        },
    )
}
