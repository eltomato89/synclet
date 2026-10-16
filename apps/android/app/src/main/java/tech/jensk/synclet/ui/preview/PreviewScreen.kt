package tech.jensk.synclet.ui.preview

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.PreviewRoute

/** Placeholder (Task 8); Task 13 implements it. */
@Composable
fun PreviewScreen(graph: AppGraph, route: PreviewRoute, onBack: () -> Unit) {
    Box(Modifier.fillMaxSize())
}

/** Placeholder (Task 8); Task 13 implements it. */
@Composable
fun PreviewPane(graph: AppGraph, accountKey: String, item: SyncItem, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize())
}
