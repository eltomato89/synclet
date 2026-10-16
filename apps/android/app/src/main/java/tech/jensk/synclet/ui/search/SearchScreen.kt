package tech.jensk.synclet.ui.search

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.ui.FolderRoute
import tech.jensk.synclet.ui.PreviewRoute
import tech.jensk.synclet.ui.SearchRoute

/** Placeholder (Task 8); Task 14 implements it. */
@Composable
fun SearchScreen(graph: AppGraph, route: SearchRoute, onOpenFolder: (FolderRoute) -> Unit, onOpenPreview: (PreviewRoute) -> Unit) {
    Box(Modifier.fillMaxSize())
}
