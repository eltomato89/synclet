package tech.jensk.synclet.ui.search

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SearchSnippet
import tech.jensk.synclet.ui.FolderRoute
import tech.jensk.synclet.ui.PreviewRoute
import tech.jensk.synclet.ui.SearchRoute
import tech.jensk.synclet.ui.TestTags
import tech.jensk.synclet.ui.components.EmptyState
import tech.jensk.synclet.ui.components.ErrorState
import tech.jensk.synclet.ui.components.ItemRow
import tech.jensk.synclet.ui.components.LoadingBox
import tech.jensk.synclet.ui.components.syncErrorMessage

@Composable
fun SearchScreen(graph: AppGraph, route: SearchRoute, onOpenFolder: (FolderRoute) -> Unit, onOpenPreview: (PreviewRoute) -> Unit) {
    val selected by graph.selectedAccountKey.collectAsStateWithLifecycle()
    val key = route.accountKey ?: selected
    val session = key?.let { graph.session(it) }
    if (key == null || session == null) return
    val vm: SearchViewModel = viewModel(key = "search/$key/${route.folderId}", factory = viewModelFactory {
        initializer { SearchViewModel(session, route.folderId, route.folderName) }
    })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = state.query, onValueChange = vm::onQueryChange, singleLine = true,
            placeholder = { Text(stringResource(R.string.search_hint)) },
            modifier = Modifier.fillMaxWidth().padding(16.dp).focusRequester(focus).testTag(TestTags.SEARCH_FIELD),
        )
        if (route.folderId != null) {
            FilterChip(
                selected = state.scopeToFolder, onClick = { vm.setScopeToFolder(!state.scopeToFolder) },
                label = { Text(stringResource(R.string.search_only_in, route.folderName.orEmpty())) },
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        }
        val highlight = SpanStyle(fontWeight = FontWeight.Bold, background = MaterialTheme.colorScheme.primaryContainer)
        when {
            state.error != null && state.hits.isEmpty() -> ErrorState(context.syncErrorMessage(state.error!!), onRetry = vm::retry)
            state.loading && state.hits.isEmpty() -> LoadingBox()
            state.query.isNotBlank() && !state.loading && state.hits.isEmpty() -> EmptyState(stringResource(R.string.search_no_results))
            else -> LazyColumn(Modifier.fillMaxSize()) {
                itemsIndexed(state.hits, key = { i, h -> "${h.item.id}/$i" }) { index, hit ->
                    if (index >= state.hits.size - 5) vm.loadMore()
                    val item = hit.item
                    Column(Modifier.testTag(TestTags.searchHit(item.name))) {
                        ItemRow(
                            item, graph.imageLoader, session.api, key, selected = false, selectionMode = false,
                            onClick = {
                                if (item.isFolder) onOpenFolder(FolderRoute(key, item.id, item.name))
                                else onOpenPreview(PreviewRoute(key, item.parentId, item.id))
                            },
                            onLongClick = {}, subtitle = "/" + hit.path,
                        )
                        hit.snippet?.takeIf { it.isNotBlank() }?.let { snippet ->
                            val text = buildAnnotatedString {
                                SearchSnippet.parse(snippet).forEach { seg ->
                                    if (seg.highlighted) withStyle(highlight) { append(seg.text) } else append(seg.text)
                                }
                            }
                            Text(text, Modifier.padding(start = 72.dp, end = 16.dp, bottom = 8.dp), maxLines = 2,
                                overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}
