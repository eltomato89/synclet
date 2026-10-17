package tech.jensk.synclet.ui.recent

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.ui.PreviewRoute
import tech.jensk.synclet.ui.components.EmptyState
import tech.jensk.synclet.ui.components.ErrorState
import tech.jensk.synclet.ui.components.ItemRow
import tech.jensk.synclet.ui.components.LoadingBox
import tech.jensk.synclet.ui.components.formatDate
import tech.jensk.synclet.ui.components.syncErrorMessage

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecentScreen(graph: AppGraph, onOpenPreview: (PreviewRoute) -> Unit) {
    val selected by graph.selectedAccountKey.collectAsStateWithLifecycle()
    val key = selected ?: return
    val session = graph.session(key) ?: return
    val vm: RecentViewModel = viewModel(key = "recent/$key", factory = viewModelFactory {
        initializer { RecentViewModel(session) }
    })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    Column(Modifier.fillMaxSize()) {
        Text(stringResource(R.string.recent_title), Modifier.padding(16.dp), style = MaterialTheme.typography.titleLarge)
        PullToRefreshBox(isRefreshing = state.loading && state.items.isNotEmpty(), onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
            when {
                state.error != null && state.items.isEmpty() -> ErrorState(context.syncErrorMessage(state.error!!), onRetry = vm::refresh)
                state.loading && state.items.isEmpty() -> LoadingBox()
                state.items.isEmpty() -> EmptyState(stringResource(R.string.recent_empty))
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    items(state.items, key = { it.id }) { item ->
                        ItemRow(
                            item, graph.imageLoader, session.api, key, selected = false, selectionMode = false,
                            onClick = { onOpenPreview(PreviewRoute(key, item.parentId, item.id)) }, onLongClick = {},
                            subtitle = formatDate(item.modifiedAt),
                        )
                    }
                }
            }
        }
    }
}
