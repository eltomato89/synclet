package tech.jensk.synclet.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.NameRules
import tech.jensk.synclet.ui.TestTags

@Composable
fun NameDialog(
    title: String, initial: String, confirmLabel: String, error: String?, busy: Boolean,
    onConfirm: (String) -> Unit, onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    var value by remember {
        val dot = initial.lastIndexOf('.')
        mutableStateOf(TextFieldValue(initial, TextRange(0, if (dot > 0) dot else initial.length)))
    }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val problem = NameRules.check(value.text)
    val shown = problem?.let { context.nameProblemMessage(it) } ?: error
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column {
                OutlinedTextField(
                    value = value, onValueChange = { value = it }, singleLine = true, enabled = !busy,
                    isError = shown != null,
                    supportingText = shown?.let { { Text(it) } },
                    modifier = Modifier.focusRequester(focus).testTag(TestTags.NAME_FIELD),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(value.text) }, enabled = problem == null && !busy,
                modifier = Modifier.testTag(TestTags.CONFIRM)) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(stringResource(R.string.action_cancel)) } },
    )
}
