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

/**
 * Initial selection in the name field: a file's name without its extension ("Report" of "Report.pdf"),
 * a folder's whole name (in "Scan 2026.10" the dot is not an extension).
 */
internal fun initialNameSelection(name: String, isFolder: Boolean): TextRange {
    val dot = name.lastIndexOf('.')
    return TextRange(0, if (!isFolder && dot > 0) dot else name.length)
}

@Composable
fun NameDialog(
    title: String, initial: String, confirmLabel: String, error: String?, busy: Boolean,
    onConfirm: (String) -> Unit, onDismiss: () -> Unit, isFolder: Boolean = false,
) {
    val context = LocalContext.current
    var value by remember { mutableStateOf(TextFieldValue(initial, initialNameSelection(initial, isFolder))) }
    // An empty field is only an error once the user has typed; a new folder dialog opens without one.
    var edited by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val problem = NameRules.check(value.text)
    val shownProblem = problem?.takeIf { edited || it != NameRules.Problem.EMPTY }
    val shown = shownProblem?.let { context.nameProblemMessage(it) } ?: error
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column {
                OutlinedTextField(
                    value = value, onValueChange = { if (it.text != value.text) edited = true; value = it }, singleLine = true, enabled = !busy,
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
