package tech.jensk.synclet.ui.components

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.core.layout.SpaceLayout
import tech.jensk.synclet.ui.TestTags

class FolderPickerViewModel(
    private val api: SyncApi, private val layout: SpaceLayout, private val personalName: String, private val excludeIds: Set<String>,
) : ViewModel() {
    data class Level(val folder: SyncItem?, val name: String)          // folder == null: list of spaces
    data class Entry(val id: String, val name: String, val enabled: Boolean, val folder: SyncItem?, val space: SyncSpace?)
    data class State(
        val path: List<Level>, val entries: List<Entry> = emptyList(), val loading: Boolean = false,
        val error: Throwable? = null,
    ) {
        val current: Level get() = path.last()
    }

    private val mutable = MutableStateFlow(State(listOf(Level(null, ""))))
    val state: StateFlow<State> = mutable.asStateFlow()

    init { showSpaces() }

    val canPickHere: Boolean
        get() = state.value.current.folder?.let { layout.canCreateIn(it) && it.id !in excludeIds } == true

    private var job: Job? = null
    private var pendingSpace: SyncSpace? = null

    private fun launchLoad(block: suspend () -> Unit) {
        job?.cancel()
        job = viewModelScope.launch { block() }
    }

    fun openSpace(space: SyncSpace) {
        pendingSpace = space
        val base = state.value.path
        launchLoad {
            mutable.update { it.copy(loading = true, error = null) }
            try {
                load(base, api.item(space.rootId), layout.displayName(space, personalName))
                pendingSpace = null
            } catch (e: CancellationException) { throw e } catch (e: Exception) { fail(e) }
        }
    }

    fun openFolder(folder: SyncItem) {
        val base = state.value.path
        launchLoad { load(base, folder, folder.name) }
    }

    fun up() {
        job?.cancel()
        pendingSpace = null
        val p = state.value.path
        if (p.size <= 1) return
        val parent = p.dropLast(1)
        mutable.value = State(parent)
        if (parent.last().folder == null) showSpaces() else launchLoad { reload(parent) }
    }

    fun retry() {
        val p = state.value.path
        val space = pendingSpace
        when {
            space != null -> openSpace(space)
            p.last().folder == null -> { job?.cancel(); showSpaces() }
            else -> launchLoad { reload(p) }
        }
    }

    private fun showSpaces() = mutable.update {
        State(listOf(Level(null, "")), layout.spaces.map {
            Entry(it.rootId, layout.displayName(it, personalName), enabled = !it.isMissing, folder = null, space = it)
        })
    }

    private suspend fun load(base: List<Level>, folder: SyncItem, name: String) { reload(base + Level(folder, name)) }

    private suspend fun reload(path: List<Level>) {
        mutable.update { State(path, loading = true) }
        try {
            val folders = api.allChildren(path.last().folder!!.id).filter { it.isFolder && it.id !in excludeIds }
                .sortedBy { it.name.lowercase() }
            mutable.update { State(path, folders.map { Entry(it.id, it.name, true, it, null) }) }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { fail(e) }
    }

    private fun fail(e: Exception) = mutable.update { it.copy(loading = false, error = e) }
}

@Composable
fun FolderPickerDialog(
    api: SyncApi, layout: SpaceLayout, personalName: String, title: String, confirmLabel: String,
    excludeIds: Set<String> = emptySet(), onPick: (folderId: String, folderName: String) -> Unit, onDismiss: () -> Unit,
) {
    val nonce = remember { java.util.UUID.randomUUID().toString() }
    val vm: FolderPickerViewModel = viewModel(key = "picker-$nonce") {
        FolderPickerViewModel(api, layout, personalName, excludeIds)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val spacesLabel = stringResource(R.string.picker_spaces)
    val pathText = state.path.mapIndexed { i, l -> if (i == 0) spacesLabel else l.name }.joinToString(" / ")
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 8.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    IconButton(onClick = { if (state.path.size > 1) vm.up() else onDismiss() }) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(if (state.path.size > 1) R.string.picker_back else R.string.action_cancel))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(pathText, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.StartEllipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Column(Modifier.weight(1f)) {
                    when {
                        state.error != null -> ErrorState(context.syncErrorMessage(state.error!!), onRetry = vm::retry)
                        state.loading -> LoadingBox()
                        state.entries.isEmpty() -> EmptyState(stringResource(R.string.picker_empty))
                        else -> LazyColumn(Modifier.fillMaxSize()) {
                            items(state.entries, key = { it.id }) { entry ->
                                ListItem(
                                    headlineContent = { Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                    leadingContent = {
                                        entry.folder?.let { ItemIcon(it) }
                                            ?: entry.space?.let { s -> Icon(spaceIcon(s), contentDescription = null) }
                                    },
                                    modifier = Modifier.alpha(if (entry.enabled) 1f else 0.4f)
                                        .clickable(enabled = entry.enabled, role = Role.Button) {
                                            entry.space?.let { vm.openSpace(it) } ?: entry.folder?.let { vm.openFolder(it) }
                                        },
                                )
                            }
                        }
                    }
                }
                Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
                    TextButton(
                        onClick = { state.current.folder?.let { onPick(it.id, state.current.name) } },
                        enabled = vm.canPickHere && !state.loading && state.error == null,
                        modifier = Modifier.testTag(TestTags.CONFIRM),
                    ) { Text(confirmLabel) }
                }
            }
        }
    }
}
