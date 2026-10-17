package tech.jensk.synclet.ui.sharelink

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.TestTags
import tech.jensk.synclet.ui.components.formatDate
import tech.jensk.synclet.ui.components.syncErrorMessage

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareLinkSheet(graph: AppGraph, accountKey: String, item: SyncItem, onDismiss: () -> Unit) {
    val session = graph.session(accountKey) ?: return
    // A new key per opening of the sheet (kept across rotation): reopening starts from the server state.
    val opening = rememberSaveable { java.util.UUID.randomUUID().toString() }
    val vm: ShareLinkViewModel = viewModel(key = "share/${item.id}/$opening", factory = viewModelFactory {
        initializer { ShareLinkViewModel(session.api, session.api.origin, item) }
    })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var pickDate by remember { mutableStateOf(false) }
    val form = state.form

    LaunchedEffect(state.shareEvent) {
        val url = state.url
        if (state.shareEvent > 0 && url != null) shareUrl(context, url)
        if (state.shareEvent > 0) vm.shareConsumed()
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.share_title), style = MaterialTheme.typography.titleLarge)
            Text(item.name, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            state.url?.let {
                Text(it, Modifier.testTag(TestTags.SHARE_URL), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            }

            SwitchRow(stringResource(R.string.share_password), form.usePassword) { on -> vm.edit { it.copy(usePassword = on, password = "") } }
            if (form.usePassword) {
                OutlinedTextField(
                    value = form.password, onValueChange = { p -> vm.edit { it.copy(password = p) } }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    label = { Text(stringResource(R.string.share_password)) },
                    supportingText = if (state.active?.hasPassword == true) ({ Text(stringResource(R.string.share_password_kept)) }) else null,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            SwitchRow(stringResource(R.string.share_expiry), form.expiresAt != null) { on ->
                if (on) pickDate = true else vm.edit { it.copy(expiresAt = null) }
            }
            form.expiresAt?.let {
                TextButton(onClick = { pickDate = true }) { Text(formatDate(it.toString())) }
            }
            SwitchRow(stringResource(R.string.share_allow_download), form.allowDownload) { on -> vm.edit { it.copy(allowDownload = on) } }
            if (item.isFolder) {
                SwitchRow(stringResource(R.string.share_allow_upload), form.allowUpload) { on -> vm.edit { it.copy(allowUpload = on) } }
            }

            state.error?.let { Text(context.syncErrorMessage(it), color = MaterialTheme.colorScheme.error) }

            Button(
                onClick = { vm.save() }, enabled = !state.busy && state.loaded,
                modifier = Modifier.fillMaxWidth().testTag(TestTags.SHARE_CREATE),
            ) {
                Text(stringResource(if (state.active == null) R.string.share_create else R.string.share_save))
            }
            if (state.active != null) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { state.url?.let { shareUrl(context, it) } },
                        modifier = Modifier.weight(1f),
                    ) { Text(stringResource(R.string.share_send)) }
                    OutlinedButton(onClick = { vm.revoke() }, enabled = !state.busy, modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.share_revoke), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    if (pickDate) {
        val initial = form.expiresAt?.atZone(ZoneId.systemDefault())?.toLocalDate()?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = initial)
        DatePickerDialog(
            onDismissRequest = { pickDate = false },
            confirmButton = {
                TextButton(onClick = {
                    pickerState.selectedDateMillis?.let { ms ->
                        val day = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()
                        val end = day.atTime(LocalTime.of(23, 59, 59)).atZone(ZoneId.systemDefault()).toInstant()
                        vm.edit { it.copy(expiresAt = end) }
                    }
                    pickDate = false
                }) { Text(stringResource(android.R.string.ok)) }
            },
            dismissButton = { TextButton(onClick = { pickDate = false }) { Text(stringResource(R.string.action_cancel)) } },
        ) { DatePicker(pickerState) }
    }
}

private fun shareUrl(context: Context, url: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
