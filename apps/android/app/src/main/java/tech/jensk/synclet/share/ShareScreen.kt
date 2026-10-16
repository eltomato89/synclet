package tech.jensk.synclet.share

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.flow.first
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.ShareTarget
import tech.jensk.synclet.ui.components.FolderPickerDialog
import tech.jensk.synclet.ui.components.syncErrorMessage

private class ShareInit(val last: ShareTarget?, val selected: String?)

@Composable
fun ShareScreen(graph: AppGraph, payload: SharePayload, onSignIn: () -> Unit, onDone: (Int) -> Unit, onCancel: () -> Unit) {
    val init by produceState<ShareInit?>(null) {
        value = ShareInit(graph.settings.lastShareTarget.first(), graph.selectedAccountKey.value)
    }
    val ready = init
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
            if (ready == null) CircularProgressIndicator()
            else ShareCard(graph, payload, ready, onSignIn, onDone, onCancel)
        }
    }
}

@Composable
private fun ShareCard(graph: AppGraph, payload: SharePayload, init: ShareInit, onSignIn: () -> Unit, onDone: (Int) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    val accounts = remember { graph.accounts.accounts.value.filter { !it.needsSignIn } }
    val personal = stringResource(R.string.space_personal)
    val vm: ShareViewModel = viewModel {
        ShareViewModel(
            accounts, init.selected, init.last, graph::session, personal,
            upload = { t ->
                when (payload) {
                    is SharePayload.Files -> graph.enqueueUploads(t.accountKey, t.folderId, t.folderName, payload.uris)
                    is SharePayload.Text -> graph.enqueueText(t.accountKey, t.folderId, t.folderName, payload.text, payload.subject)
                    SharePayload.Empty -> 0
                }
            },
            remember = { graph.settings.setLastShareTarget(it) },
        )
    }
    val state by vm.state.collectAsStateWithLifecycle()
    var picking by remember { mutableStateOf(false) }
    var accountMenu by remember { mutableStateOf(false) }
    LaunchedEffect(state.done) { state.done?.let(onDone) }

    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.needsAccount) {
                Text(stringResource(R.string.share_sign_in_hint), style = MaterialTheme.typography.bodyLarge)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onCancel) { Text(stringResource(R.string.share_cancel)) }
                    Button(onClick = onSignIn) { Text(stringResource(R.string.share_open_app)) }
                }
                return@Column
            }
            Text(
                when (payload) {
                    is SharePayload.Files -> pluralStringResource(R.plurals.share_items, payload.uris.size, payload.uris.size)
                    is SharePayload.Text -> payload.subject?.takeIf { it.isNotBlank() } ?: payload.text
                    SharePayload.Empty -> ""
                },
                style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
            if (vm.accounts.size > 1) {
                Box {
                    OutlinedButton(onClick = { accountMenu = true }, Modifier.fillMaxWidth()) {
                        Text(state.account?.title.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(expanded = accountMenu, onDismissRequest = { accountMenu = false }) {
                        vm.accounts.forEach { a ->
                            DropdownMenuItem(text = { Text(a.title) }, onClick = { accountMenu = false; vm.selectAccount(a.key) })
                        }
                    }
                }
            } else {
                Text(state.account?.title.orEmpty(), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(stringResource(R.string.share_destination), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(state.target?.folderName ?: stringResource(R.string.share_checking), Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = { picking = true }, enabled = !state.busy) { Text(stringResource(R.string.share_choose_folder)) }
            }
            state.error?.let {
                Text(context.syncErrorMessage(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onCancel, enabled = !state.busy) { Text(stringResource(R.string.share_cancel)) }
                Button(onClick = { vm.upload() }, enabled = state.target != null && !state.checking && !state.busy) {
                    Text(stringResource(R.string.share_upload))
                }
            }
        }
    }

    val session = state.account?.let { graph.session(it.key) }
    if (picking && session != null) {
        FolderPickerDialog(
            api = session.api, layout = session.layout, personalName = personal,
            title = stringResource(R.string.share_destination), confirmLabel = stringResource(R.string.share_choose_folder),
            onPick = { id, name -> picking = false; vm.pickFolder(id, name) },
            onDismiss = { picking = false },
        )
    }
}
