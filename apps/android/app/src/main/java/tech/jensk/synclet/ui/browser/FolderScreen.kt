package tech.jensk.synclet.ui.browser

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.automirrored.outlined.ViewList
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.window.core.layout.WindowSizeClass
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.account.SortField
import tech.jensk.synclet.core.account.ViewMode
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncSpace
import tech.jensk.synclet.ui.FolderRoute
import tech.jensk.synclet.ui.PreviewRoute
import tech.jensk.synclet.ui.SearchRoute
import tech.jensk.synclet.ui.components.ConfirmDialog
import tech.jensk.synclet.ui.components.EmptyState
import tech.jensk.synclet.ui.components.ErrorState
import tech.jensk.synclet.ui.components.FolderPickerDialog
import tech.jensk.synclet.ui.components.ItemRow
import tech.jensk.synclet.ui.components.ItemTile
import tech.jensk.synclet.ui.components.LoadingBox
import tech.jensk.synclet.ui.components.NameDialog
import tech.jensk.synclet.ui.components.OfflineBanner
import tech.jensk.synclet.ui.components.syncErrorMessage
import tech.jensk.synclet.ui.components.text
import tech.jensk.synclet.ui.preview.PreviewPane
import tech.jensk.synclet.ui.sharelink.ShareLinkSheet

@Composable
fun FolderScreen(
    graph: AppGraph,
    route: FolderRoute,
    onOpenFolder: (FolderRoute) -> Unit,
    onOpenPreview: (PreviewRoute) -> Unit,
    onSearch: (SearchRoute) -> Unit,
    onBack: () -> Unit,
) {
    // After process death the route is restored before the accounts are loaded.
    val ready by produceState(false) { runCatching { graph.awaitReady() }; value = true }
    if (!ready) { LoadingBox(); return }
    val session = graph.session(route.accountKey)
    if (session == null) {
        FolderFrame(route.title, onBack) { ErrorState(stringResource(R.string.error_gone), onRetry = onBack) }
        return
    }
    FolderContent(graph, session, route, onOpenFolder, onOpenPreview, onSearch, onBack)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FolderFrame(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Scaffold(topBar = {
        TopAppBar(title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) }, navigationIcon = { BackButton(onBack) })
    }) { padding -> Box(Modifier.padding(padding)) { content() } }
}

@Composable
private fun BackButton(onBack: () -> Unit) = IconButton(onClick = onBack) {
    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = stringResource(R.string.browser_back))
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun FolderContent(
    graph: AppGraph, session: AccountSession, route: FolderRoute, onOpenFolder: (FolderRoute) -> Unit,
    onOpenPreview: (PreviewRoute) -> Unit, onSearch: (SearchRoute) -> Unit, onBack: () -> Unit,
) {
    val vm: FolderViewModel = viewModel(key = "${route.accountKey}/${route.folderId}") {
        FolderViewModel(session, route.folderId, graph.listingCache, graph.settings, graph.folderChanges, graph::publishLocalChange)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val layout = session.layout
    val personalName = stringResource(R.string.space_personal)
    val title = state.folder?.takeUnless { it.isSpaceRoot || layout.isSpaceRoot(it.id) }?.name ?: route.title
    val selectionMode = state.selection.isNotEmpty()
    val wide = currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()

    // Dialogs
    var nameDialog by remember { mutableStateOf<NameTarget?>(null) }
    var dialogError by remember { mutableStateOf<String?>(null) }
    var dialogBusy by remember { mutableStateOf(false) }
    var moveTargets by remember { mutableStateOf<List<SyncItem>?>(null) }
    var deleteTargets by remember { mutableStateOf<List<SyncItem>?>(null) }
    var shareTarget by remember { mutableStateOf<SyncItem?>(null) }

    val messageText = state.message?.text()
    LaunchedEffect(state.message) {
        if (messageText != null) {
            snackbar.showSnackbar(messageText)
            vm.messageShown()
        }
    }

    // With items on screen a failed reload is only a note; offline gets the banner above the list instead.
    val loadError = state.error
    LaunchedEffect(loadError) {
        if (loadError != null && loadError !is SyncError.Transport && state.items.isNotEmpty())
            snackbar.showSnackbar(context.syncErrorMessage(loadError))
    }

    if (wide) BackHandler(navigator.canNavigateBack()) { scope.launch { navigator.navigateBack() } }
    BackHandler(selectionMode) { vm.clearSelection() }

    fun canShareLink(item: SyncItem): Boolean {
        val space = layout.space(item.space) ?: return item.space == SyncSpace.PERSONAL
        return space.canWrite && !space.isMissing
    }

    val openItem: (SyncItem) -> Unit = { item ->
        when {
            selectionMode -> vm.toggleSelection(item.id)
            item.isFolder -> onOpenFolder(FolderRoute(route.accountKey, item.id, item.name))
            wide -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, item.id) }
            else -> onOpenPreview(PreviewRoute(route.accountKey, route.folderId, item.id))
        }
    }
    val menuFor: (SyncItem) -> (@Composable () -> Unit)? = { item ->
        if (selectionMode) null else {
            {
                ItemMenu(
                    item, canShareLink = canShareLink(item),
                    onRename = { dialogError = null; nameDialog = NameTarget.Rename(item) },
                    onMove = { moveTargets = listOf(item) },
                    onDelete = { deleteTargets = listOf(item) },
                    onShareLink = { shareTarget = item },
                )
            }
        }
    }

    Scaffold(
        topBar = {
            if (selectionMode) {
                val selected = state.selectedItems
                TopAppBar(
                    title = { Text(stringResource(R.string.browser_selected, state.selection.size)) },
                    navigationIcon = {
                        IconButton(onClick = vm::clearSelection) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.browser_clear_selection))
                        }
                    },
                    actions = {
                        if (selected.isNotEmpty() && selected.all { it.capabilities.move }) IconButton(onClick = { moveTargets = selected }) {
                            Icon(Icons.AutoMirrored.Outlined.DriveFileMove, contentDescription = stringResource(R.string.browser_move))
                        }
                        if (selected.isNotEmpty() && selected.all { it.capabilities.delete }) IconButton(onClick = { deleteTargets = selected }) {
                            Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.browser_delete))
                        }
                    },
                )
            } else {
                TopAppBar(
                    title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = { BackButton(onBack) },
                    actions = {
                        IconButton(onClick = { onSearch(SearchRoute(route.accountKey, route.folderId, title)) }) {
                            Icon(Icons.Outlined.Search, contentDescription = stringResource(R.string.browser_search))
                        }
                        if (state.viewMode == ViewMode.LIST) IconButton(onClick = { vm.setViewMode(ViewMode.GRID) }) {
                            Icon(Icons.Outlined.GridView, contentDescription = stringResource(R.string.browser_view_grid))
                        } else IconButton(onClick = { vm.setViewMode(ViewMode.LIST) }) {
                            Icon(Icons.AutoMirrored.Outlined.ViewList, contentDescription = stringResource(R.string.browser_view_list))
                        }
                        SortMenu(state.sort.field, state.sort.ascending) { vm.setSort(state.sort.next(it)) }
                    },
                )
            }
        },
        floatingActionButton = {
            if (!selectionMode && state.folder?.let { layout.canCreateIn(it) } == true) {
                AddMenu(
                    onUris = { uris -> enqueue(graph, route, title, uris, scope, snackbar, context) },
                    onNewFolder = { dialogError = null; nameDialog = NameTarget.NewFolder },
                )
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val list = @Composable {
            ItemsPane(graph, session, state, vm, openItem, menuFor)
        }
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (wide) {
                ListDetailPaneScaffold(
                    directive = navigator.scaffoldDirective,
                    value = navigator.scaffoldValue,
                    listPane = { AnimatedPane { list() } },
                    detailPane = {
                        AnimatedPane {
                            val id = navigator.currentDestination?.contentKey
                            val item = state.items.firstOrNull { it.id == id && !it.isFolder }
                            if (item != null) PreviewPane(graph, route.accountKey, item, Modifier.fillMaxSize())
                            else EmptyState(stringResource(R.string.browser_select_file))
                        }
                    },
                )
            } else list()
        }
    }

    when (val target = nameDialog) {
        null -> {}
        else -> {
            val close = { nameDialog = null; dialogBusy = false; dialogError = null }
            val onResult: (Throwable?) -> Unit = { err ->
                dialogBusy = false
                if (err == null) close() else dialogError = context.syncErrorMessage(err)
            }
            NameDialog(
                title = stringResource(if (target is NameTarget.Rename) R.string.browser_rename else R.string.browser_new_folder),
                initial = (target as? NameTarget.Rename)?.item?.name.orEmpty(),
                confirmLabel = stringResource(if (target is NameTarget.Rename) R.string.browser_rename else R.string.browser_create),
                error = dialogError, busy = dialogBusy,
                onConfirm = { name ->
                    dialogBusy = true
                    dialogError = null
                    when (target) {
                        is NameTarget.Rename -> vm.rename(target.item, name, onResult)
                        NameTarget.NewFolder -> vm.createFolder(name, onResult)
                    }
                },
                onDismiss = close,
            )
        }
    }

    moveTargets?.let { targets ->
        FolderPickerDialog(
            api = session.api, layout = layout, personalName = personalName,
            title = stringResource(R.string.browser_move_title), confirmLabel = stringResource(R.string.browser_move_here),
            excludeIds = targets.map { it.id }.toSet(),
            onPick = { folderId, _ -> moveTargets = null; vm.move(targets, folderId) },
            onDismiss = { moveTargets = null },
        )
    }

    deleteTargets?.let { targets ->
        ConfirmDialog(
            title = stringResource(R.string.browser_delete_title),
            text = pluralStringResource(R.plurals.browser_delete_text, targets.size, targets.size),
            confirmLabel = stringResource(R.string.browser_delete), destructive = true,
            onConfirm = { deleteTargets = null; vm.delete(targets) },
            onDismiss = { deleteTargets = null },
        )
    }

    shareTarget?.let { item -> ShareLinkSheet(graph, route.accountKey, item) { shareTarget = null } }
}

private sealed interface NameTarget {
    data object NewFolder : NameTarget
    data class Rename(val item: SyncItem) : NameTarget
}

/** Copies run in the app scope: leaving the folder must not cut an enqueue short. */
private fun enqueue(
    graph: AppGraph, route: FolderRoute, title: String, uris: List<Uri>, scope: kotlinx.coroutines.CoroutineScope,
    snackbar: SnackbarHostState, context: android.content.Context,
) {
    val resources = context.resources
    scope.launch {
        val n = runCatching {
            graph.scope.async { graph.enqueueUploads(route.accountKey, route.folderId, title, uris) }.await()
        }.getOrElse { if (it is kotlinx.coroutines.CancellationException) throw it; 0 }
        if (n > 0) snackbar.showSnackbar(resources.getQuantityString(R.plurals.browser_uploads_queued, n, n))
        else snackbar.showSnackbar(context.getString(R.string.error_unexpected))
    }
}

@Composable
private fun SortMenu(field: SortField, ascending: Boolean, onSelect: (SortField) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) {
            Icon(Icons.AutoMirrored.Outlined.Sort, contentDescription = stringResource(R.string.browser_sort))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(SortField.NAME to R.string.browser_sort_name, SortField.DATE to R.string.browser_sort_date,
                SortField.SIZE to R.string.browser_sort_size).forEach { (f, label) ->
                DropdownMenuItem(
                    text = { Text(stringResource(label)) },
                    trailingIcon = if (f == field) {
                        { Icon(if (ascending) Icons.Outlined.ArrowUpward else Icons.Outlined.ArrowDownward, contentDescription = null) }
                    } else null,
                    onClick = { open = false; onSelect(f) },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ItemsPane(
    graph: AppGraph, session: AccountSession, state: FolderViewModel.State, vm: FolderViewModel,
    onOpen: (SyncItem) -> Unit, menuFor: (SyncItem) -> (@Composable () -> Unit)?,
) {
    val context = LocalContext.current
    val selectionMode = state.selection.isNotEmpty()
    val error = state.error
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
        when {
            state.loading && state.items.isEmpty() -> LoadingBox()
            error != null && state.items.isEmpty() ->
                Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                    ErrorState(context.syncErrorMessage(error), onRetry = vm::refresh)
                }
            else -> Column(Modifier.fillMaxSize()) {
                if (error is SyncError.Transport) OfflineBanner(onRetry = vm::refresh)
                if (state.items.isEmpty()) {
                    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        EmptyState(stringResource(R.string.browser_empty))
                    }
                } else if (state.viewMode == ViewMode.LIST) {
                    val listState = rememberLazyListState()
                    LoadMoreEffect(state.items.size, { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1 }, vm::loadMore)
                    LazyColumn(Modifier.fillMaxSize(), state = listState) {
                        items(state.items, key = { it.id }) { item ->
                            ItemRow(item, graph.imageLoader, session.api, session.key, selected = item.id in state.selection,
                                selectionMode = selectionMode, onClick = { onOpen(item) }, onLongClick = { vm.toggleSelection(item.id) },
                                menu = menuFor(item))
                        }
                        if (state.loadingMore) item(key = "loadingMore") { MoreIndicator() }
                    }
                } else {
                    val gridState = rememberLazyGridState()
                    LoadMoreEffect(state.items.size, { gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1 }, vm::loadMore)
                    LazyVerticalGrid(
                        GridCells.Adaptive(120.dp), Modifier.fillMaxSize(), state = gridState,
                        contentPadding = PaddingValues(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(state.items.size, key = { state.items[it].id }) { index ->
                            val item = state.items[index]
                            ItemTile(item, graph.imageLoader, session.api, session.key, selected = item.id in state.selection,
                                selectionMode = selectionMode, onClick = { onOpen(item) }, onLongClick = { vm.toggleSelection(item.id) },
                                menu = menuFor(item))
                        }
                        if (state.loadingMore) item(key = "loadingMore", span = { GridItemSpan(maxLineSpan) }) { MoreIndicator() }
                    }
                }
            }
        }
    }
}

/** Asks for the next page once the last visible row is within 20 of the end. */
@Composable
private fun LoadMoreEffect(count: Int, lastVisible: () -> Int, loadMore: () -> Unit) {
    val load by rememberUpdatedState(loadMore)
    LaunchedEffect(count) {
        snapshotFlow(lastVisible).distinctUntilChanged().filter { count > 0 && it >= count - 20 }.collect { load() }
    }
}

@Composable
private fun MoreIndicator() = Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
    CircularProgressIndicator()
}
