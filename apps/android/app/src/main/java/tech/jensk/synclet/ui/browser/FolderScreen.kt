package tech.jensk.synclet.ui.browser

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.ui.FolderRoute
import tech.jensk.synclet.ui.PreviewRoute
import tech.jensk.synclet.ui.SearchRoute

/** Placeholder (Task 8); Task 12 implements it. */
@Composable
fun FolderScreen(
    graph: AppGraph,
    route: FolderRoute,
    onOpenFolder: (FolderRoute) -> Unit,
    onOpenPreview: (PreviewRoute) -> Unit,
    onSearch: (SearchRoute) -> Unit,
    onBack: () -> Unit,
) {
    Box(Modifier.fillMaxSize())
}
