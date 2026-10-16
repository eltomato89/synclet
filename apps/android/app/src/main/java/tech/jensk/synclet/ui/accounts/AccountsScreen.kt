package tech.jensk.synclet.ui.accounts

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.Account
import tech.jensk.synclet.login.LoginActivity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountsScreen(graph: AppGraph, onBack: () -> Unit) {
    val vm = viewModel { AccountsViewModel(graph) }
    val accounts by vm.accounts.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var confirmKey by rememberSaveable { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.accounts_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.shell_back))
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { context.startActivity(Intent(context, LoginActivity::class.java)) },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text(stringResource(R.string.accounts_add)) },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            items(accounts, key = { it.key }) { account ->
                ListItem(
                    headlineContent = { Text(account.title) },
                    supportingContent = {
                        if (account.needsSignIn) {
                            OutlinedButton(onClick = { signInAgain(context, account) }) {
                                Text(stringResource(R.string.account_sign_in_required))
                            }
                        } else {
                            Text(stringResource(R.string.account_signed_in))
                        }
                    },
                    leadingContent = {
                        if (account.key == selected) Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        else Icon(Icons.Outlined.AccountCircle, contentDescription = null)
                    },
                    trailingContent = {
                        TextButton(onClick = { confirmKey = account.key }) { Text(stringResource(R.string.accounts_sign_out)) }
                    },
                    modifier = Modifier.clickable { vm.select(account.key) },
                )
            }
        }
    }

    val confirming = confirmKey?.let { key -> accounts.firstOrNull { it.key == key } }
    if (confirming != null) {
        AlertDialog(
            onDismissRequest = { confirmKey = null },
            text = { Text(stringResource(R.string.accounts_sign_out_confirm, confirming.title)) },
            confirmButton = {
                TextButton(onClick = { vm.signOut(confirming.key); confirmKey = null }) {
                    Text(stringResource(R.string.accounts_sign_out))
                }
            },
            dismissButton = { TextButton(onClick = { confirmKey = null }) { Text(stringResource(R.string.accounts_cancel)) } },
        )
    }
}

/** Opens the sign-in with the server and user name of the account filled in. */
internal fun signInAgain(context: Context, account: Account) {
    context.startActivity(
        Intent(context, LoginActivity::class.java)
            .putExtra(LoginActivity.EXTRA_SERVER, account.serverUrl)
            .putExtra(LoginActivity.EXTRA_LOGIN_HINT, account.username),
    )
}
