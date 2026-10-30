package tech.jensk.synclet.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.ViewMode
import tech.jensk.synclet.ui.components.formatBytes

private const val PROJECT_URL = "https://github.com/eltomato89/synclet"
private const val PRIVACY_URL = "https://eltomato89.github.io/synclet/privacy.html"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(graph: AppGraph, onBack: () -> Unit) {
    val vm = viewModel { SettingsViewModel({ graph.fileCache.sizeBytes() }, { graph.clearCaches() }) }
    val cacheBytes by vm.cacheBytes.collectAsStateWithLifecycle()
    val viewMode by graph.settings.viewMode.collectAsStateWithLifecycle(ViewMode.LIST)
    val accounts by graph.accounts.accounts.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(stringResource(R.string.settings_title)) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.shell_back))
                }
            },
        )
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            Header(R.string.settings_view)
            Column(Modifier.selectableGroup()) {
                listOf(ViewMode.LIST to R.string.settings_view_list, ViewMode.GRID to R.string.settings_view_grid).forEach { (mode, label) ->
                    ListItem(
                        headlineContent = { Text(stringResource(label)) },
                        leadingContent = { RadioButton(selected = viewMode == mode, onClick = null) },
                        modifier = Modifier.selectable(selected = viewMode == mode, role = Role.RadioButton) {
                            scope.launch { graph.settings.setViewMode(mode) }
                        },
                    )
                }
            }
            HorizontalDivider()
            Header(R.string.settings_storage)
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_cache_size, formatBytes(cacheBytes))) },
                trailingContent = { TextButton(onClick = { vm.clearCache() }) { Text(stringResource(R.string.settings_clear_cache)) } },
            )
            HorizontalDivider()
            Header(R.string.settings_accounts)
            ListItem(headlineContent = {
                Text(pluralStringResource(R.plurals.settings_accounts_count, accounts.size, accounts.size))
            })
            HorizontalDivider()
            Header(R.string.settings_about)
            ListItem(headlineContent = { Text(stringResource(R.string.settings_version, graph.appVersion)) })
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_project_page)) },
                supportingContent = { Text(PROJECT_URL) },
                modifier = Modifier.selectable(selected = false, role = Role.Button) {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PROJECT_URL))) }
                },
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_privacy_policy)) },
                modifier = Modifier.selectable(selected = false, role = Role.Button) {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL))) }
                },
            )
        }
    }
}

@Composable
private fun Header(label: Int) {
    Text(stringResource(label), Modifier.padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}
