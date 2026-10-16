package tech.jensk.synclet.ui.trash

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.TrashEntry
import tech.jensk.synclet.ui.TestTags
import tech.jensk.synclet.ui.components.ConfirmDialog
import tech.jensk.synclet.ui.components.EmptyState
import tech.jensk.synclet.ui.components.ErrorState
import tech.jensk.synclet.ui.components.LoadingBox
import tech.jensk.synclet.ui.components.UiMessage
import tech.jensk.synclet.ui.components.formatDate
import tech.jensk.synclet.ui.components.syncErrorMessage

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(graph: AppGraph, onBack: (() -> Unit)?) {
    val selected by graph.selectedAccountKey.collectAsStateWithLifecycle()
    val key = selected ?: return
    val session = graph.session(key) ?: return
    val vm: TrashViewModel = viewModel(key = "trash/$key", factory = viewModelFactory {
        initializer { TrashViewModel(session, graph::publishLocalChange) }
    })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var menu by remember { mutableStateOf(false) }
    var confirmEmpty by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<TrashEntry?>(null) }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.load() }

    val message = state.message
    val messageText = when (message) {
        null -> null
        is UiMessage.Text -> context.getString(message.res, *message.args.toTypedArray())
        is UiMessage.Error -> message.error.let { e ->
            if (e is SyncError.Http && e.status == 409) context.getString(R.string.trash_busy, e.serverMessage.orEmpty())
            else context.syncErrorMessage(e)
        }
    }
    LaunchedEffect(message) {
        if (messageText != null) { snackbar.showSnackbar(messageText); vm.messageShown() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.trash_title)) },
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, null) }
                },
                actions = {
                    if (state.entries.isNotEmpty()) {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, null) }
                        DropdownMenu(menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.trash_empty)) }, onClick = { menu = false; confirmEmpty = true })
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                state.error != null && state.groups.isEmpty() -> ErrorState(context.syncErrorMessage(state.error!!), onRetry = vm::load)
                state.loading && state.groups.isEmpty() -> LoadingBox()
                state.groups.isEmpty() -> EmptyState(stringResource(R.string.trash_empty_state))
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    state.groups.forEach { (space, entries) ->
                        item(key = "h/${space?.id}") {
                            val name = space?.let { session.layout.displayName(it, graph.personalSpaceName()) }
                                ?: stringResource(R.string.trash_group_unknown)
                            Text(name, Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 4.dp),
                                style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                        }
                        items(entries, key = { it.id }) { entry ->
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                                Text(entry.name, style = MaterialTheme.typography.bodyLarge)
                                Text(entry.originalPath, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(stringResource(R.string.trash_deleted_at, formatDate(entry.deletedAt)),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                entry.expiresAt?.let {
                                    Text(stringResource(R.string.trash_expires_at, formatDate(it)),
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                    TextButton(onClick = { confirmDelete = entry }) {
                                        Text(stringResource(R.string.trash_delete_forever), color = MaterialTheme.colorScheme.error)
                                    }
                                    TextButton(onClick = { vm.restore(entry) }, modifier = Modifier.testTag(TestTags.trashRestore(entry.name))) {
                                        Text(stringResource(R.string.trash_restore))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    confirmDelete?.let { entry ->
        ConfirmDialog(
            title = stringResource(R.string.trash_delete_forever), text = stringResource(R.string.trash_delete_forever_text, entry.name),
            confirmLabel = stringResource(R.string.trash_delete_forever), destructive = true,
            onConfirm = { confirmDelete = null; vm.deleteForever(entry) }, onDismiss = { confirmDelete = null },
        )
    }
    if (confirmEmpty) {
        val unknownName = stringResource(R.string.trash_group_unknown)
        val names = state.groups.joinToString(", ") { (space, _) ->
            space?.let { session.layout.displayName(it, graph.personalSpaceName()) } ?: unknownName
        }
        ConfirmDialog(
            title = stringResource(R.string.trash_empty), text = stringResource(R.string.trash_empty_text, names),
            confirmLabel = stringResource(R.string.trash_empty), destructive = true,
            onConfirm = { confirmEmpty = false; vm.emptyAll() }, onDismiss = { confirmEmpty = false },
        )
    }
}
