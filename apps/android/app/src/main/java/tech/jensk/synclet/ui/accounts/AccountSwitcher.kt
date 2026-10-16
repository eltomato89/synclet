package tech.jensk.synclet.ui.accounts

import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R

/** Title of the active account; with more than one account a menu to switch. */
@Composable
fun AccountSwitcher(graph: AppGraph, modifier: Modifier = Modifier) {
    val accounts by graph.accounts.accounts.collectAsStateWithLifecycle()
    val selectedKey by graph.selectedAccountKey.collectAsStateWithLifecycle()
    val current = accounts.firstOrNull { it.key == selectedKey } ?: return
    if (accounts.size < 2) {
        Text(current.title, modifier, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        return
    }
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        TextButton(onClick = { open = true }) {
            Text(current.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            accounts.forEach { account ->
                DropdownMenuItem(
                    text = {
                        Text(if (account.needsSignIn) "${account.title} · ${stringResource(R.string.account_sign_in_required)}" else account.title)
                    },
                    onClick = {
                        open = false
                        scope.launch { graph.settings.setSelectedAccount(account.key) }
                    },
                )
            }
        }
    }
}
