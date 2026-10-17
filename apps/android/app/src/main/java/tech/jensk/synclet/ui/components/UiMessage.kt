package tech.jensk.synclet.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource

sealed interface UiMessage {
    /** [plural]: [res] is an R.plurals.* id, the quantity is `args[0]`. */
    data class Text(val res: Int, val args: List<Any> = emptyList(), val plural: Boolean = false) : UiMessage
    data class Error(val error: Throwable) : UiMessage
}

@Composable
fun UiMessage.text(): String = when (this) {
    is UiMessage.Text -> if (plural) pluralStringResource(res, args.first() as Int, *args.toTypedArray())
                         else stringResource(res, *args.toTypedArray())
    is UiMessage.Error -> LocalContext.current.syncErrorMessage(error)
}
