package tech.jensk.synclet.ui.preview

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.PreviewRoute
import tech.jensk.synclet.ui.components.syncErrorMessage
import tech.jensk.synclet.ui.sharelink.ShareLinkSheet

@Composable
internal fun LoadingProgress(progress: Float?) {
    Box(contentAlignment = Alignment.Center) {
        if (progress == null || progress <= 0f || progress >= 1f) {
            CircularProgressIndicator()
        } else {
            CircularProgressIndicator(progress = { progress })
        }
        if (progress != null && progress > 0f && progress < 1f) {
            Text(stringResource(R.string.preview_loading, (progress * 100).toInt()), modifier = Modifier.padding(top = 72.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PreviewScreen(graph: AppGraph, route: PreviewRoute, onBack: () -> Unit) {
    val session = graph.session(route.accountKey)
    if (session == null) {
        LaunchedEffect(Unit) { onBack() }
        return
    }
    val vm: PreviewViewModel = viewModel(key = "${route.accountKey}/${route.itemId}") {
        PreviewViewModel(session, route.accountKey, route.folderId, route.itemId, graph.listingCache, graph.fileCache)
    }
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var zoomed by remember { mutableStateOf(false) }

    if (state.loading || state.siblings.isEmpty()) {
        Scaffold(
            topBar = { TopAppBar(title = {}, navigationIcon = { BackButton(onBack) }) },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                val error = state.error
                if (error != null) Text(context.syncErrorMessage(error)) else CircularProgressIndicator()
            }
        }
        return
    }

    val pager = rememberPagerState(initialPage = state.index) { state.siblings.size }
    val current = state.siblings[pager.currentPage.coerceIn(0, state.siblings.lastIndex)]
    var shareLinkFor by remember { mutableStateOf<SyncItem?>(null) }
    LaunchedEffect(pager.currentPage) { zoomed = false }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(current.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    PreviewActionButtons(graph, vm, route.accountKey, current, snackbar) { shareLinkFor = it }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        HorizontalPager(pager, Modifier.fillMaxSize().padding(padding), userScrollEnabled = !zoomed, beyondViewportPageCount = 0, key = { state.siblings[it].id }) { page ->
            val item = state.siblings[page]
            PreviewPage(graph, vm, route.accountKey, item, isCurrent = page == pager.currentPage, onZoomChanged = { if (page == pager.currentPage) zoomed = it }) {
                scope.launch { snackbar.showSnackbar(it) }
            }
        }
    }
    shareLinkFor?.let { ShareLinkSheet(graph, route.accountKey, it) { shareLinkFor = null } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PreviewPane(graph: AppGraph, accountKey: String, item: SyncItem, modifier: Modifier = Modifier) {
    val session = graph.session(accountKey) ?: return
    val vm: PreviewViewModel = viewModel(key = "$accountKey/pane/${item.id}") {
        graph.listingCache.putItem(accountKey, item)
        PreviewViewModel(session, accountKey, null, item.id, graph.listingCache, graph.fileCache)
    }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var shareLinkFor by remember { mutableStateOf<SyncItem?>(null) }
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                actions = { PreviewActionButtons(graph, vm, accountKey, item, snackbar) { shareLinkFor = it } },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            PreviewPage(graph, vm, accountKey, item, isCurrent = true, onZoomChanged = {}) { scope.launch { snackbar.showSnackbar(it) } }
        }
    }
    shareLinkFor?.let { ShareLinkSheet(graph, accountKey, it) { shareLinkFor = null } }
}

@Composable
private fun BackButton(onBack: () -> Unit) {
    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.preview_back)) }
}

@Composable
private fun PreviewPage(
    graph: AppGraph, vm: PreviewViewModel, accountKey: String, item: SyncItem, isCurrent: Boolean,
    onZoomChanged: (Boolean) -> Unit, onMessage: (String) -> Unit,
) {
    when (PreviewKind.of(item)) {
        PreviewKind.IMAGE -> ImagePage(graph, vm, accountKey, item, onZoomChanged)
        PreviewKind.VIDEO, PreviewKind.AUDIO -> MediaPage(vm, item, isCurrent)
        PreviewKind.PDF -> PdfPage(vm, item)
        PreviewKind.TEXT -> TextPage(vm, item)
        PreviewKind.OTHER -> OtherPage(vm, accountKey, item, onMessage)
    }
}

@Composable
private fun PreviewActionButtons(
    graph: AppGraph, vm: PreviewViewModel, accountKey: String, item: SyncItem, snackbar: SnackbarHostState,
    onShareLink: (SyncItem) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val saved = stringResource(R.string.preview_saved)
    val noApp = stringResource(R.string.preview_no_app)
    // Runs a file action after the original is in the FileCache, so the provider answers immediately.
    fun withOriginal(action: suspend (java.io.File) -> Unit) {
        scope.launch {
            try {
                action(vm.original(item))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                snackbar.showSnackbar(context.syncErrorMessage(e))
            }
        }
    }
    IconButton(onClick = { withOriginal { shareFile(context, accountKey, item) } }) {
        Icon(Icons.Outlined.Share, stringResource(R.string.preview_share))
    }
    if (item.capabilities.write) {
        IconButton(onClick = { onShareLink(item) }) { Icon(Icons.Outlined.Link, stringResource(R.string.preview_share_link)) }
    }
    IconButton(onClick = {
        withOriginal { file ->
            MediaStoreSaver.saveToDownloads(context, file, item.name, item.mime)
            snackbar.showSnackbar(saved)
        }
    }) { Icon(Icons.Outlined.Download, stringResource(R.string.preview_download)) }
    IconButton(onClick = {
        withOriginal { if (!openWith(context, accountKey, item)) snackbar.showSnackbar(noApp) }
    }) { Icon(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.preview_open_with)) }
}
