package tech.jensk.synclet.ui.browser

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.login.LoginActivity
import tech.jensk.synclet.ui.FolderRoute
import tech.jensk.synclet.ui.TestTags
import tech.jensk.synclet.ui.accounts.AccountSwitcher
import tech.jensk.synclet.ui.components.spaceIcon
import tech.jensk.synclet.ui.components.syncErrorMessage

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SpacesScreen(graph: AppGraph, accountKey: String, onOpenFolder: (FolderRoute) -> Unit) {
    val context = LocalContext.current
    val personalName = stringResource(R.string.space_personal)
    val vm: SpacesViewModel = viewModel(key = "spaces/$accountKey") {
        SpacesViewModel(graph.accounts, accountKey, graph.folderChanges, personalName)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val accounts by graph.accounts.accounts.collectAsStateWithLifecycle()
    val account = accounts.firstOrNull { it.key == accountKey }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(state.error) {
        state.error?.let {
            snackbar.showSnackbar(context.syncErrorMessage(it))
            vm.errorShown()
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { AccountSwitcher(graph) }) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = vm::refresh,
            modifier = Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (account?.needsSignIn == true) item(key = "signIn") {
                    Card(Modifier.fillMaxWidth().padding(16.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                        Column(Modifier.padding(16.dp)) {
                            Text(stringResource(R.string.browser_sign_in_again_text), style = MaterialTheme.typography.bodyMedium)
                            Button(onClick = {
                                context.startActivity(Intent(context, LoginActivity::class.java)
                                    .putExtra(LoginActivity.EXTRA_SERVER, account.serverUrl)
                                    .putExtra(LoginActivity.EXTRA_LOGIN_HINT, account.username))
                            }, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.browser_sign_in_again)) }
                        }
                    }
                }
                items(state.spaces, key = { it.space.id }) { row ->
                    val subtitle = when {
                        !row.available -> stringResource(R.string.browser_unavailable)
                        row.readOnly -> stringResource(R.string.browser_read_only)
                        else -> null
                    }
                    ListItem(
                        leadingContent = {
                            Icon(spaceIcon(row.space), contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        },
                        headlineContent = { Text(row.name) },
                        supportingContent = subtitle?.let { { Text(it) } },
                        modifier = Modifier
                            .testTag(TestTags.space(row.space.id))
                            .alpha(if (row.available) 1f else 0.4f)
                            .clickable(enabled = row.available, role = Role.Button) {
                                onOpenFolder(FolderRoute(accountKey, row.space.rootId, row.name))
                            },
                    )
                }
            }
        }
    }
}
