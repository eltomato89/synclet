package tech.jensk.synclet.ui.preview

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import coil3.compose.AsyncImage
import java.io.File
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.cache.ThumbnailCache

@Composable
fun ImagePage(
    graph: AppGraph, vm: PreviewViewModel, accountKey: String, item: SyncItem, onZoomChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var original by remember(item.id) { mutableStateOf<File?>(null) }
    var scale by remember(item.id) { mutableFloatStateOf(1f) }
    var offset by remember(item.id) { mutableStateOf(Offset.Zero) }
    LaunchedEffect(item.id) { original = runCatching { vm.original(item) }.getOrNull() }
    LaunchedEffect(scale) { onZoomChanged(scale > 1f) }

    val thumb = remember(item.id) {
        graph.session(accountKey)?.let { ThumbnailCache.request(context, it.api, accountKey, item, 1024) }
    }
    Box(
        modifier.fillMaxSize()
            .pointerInput(item.id) {
                detectTapGestures(onDoubleTap = {
                    if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f
                })
            }
            .pointerInput(item.id) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
    ) {
        if (thumb != null) {
            AsyncImage(thumb, item.name, graph.imageLoader, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        }
        original?.let { AsyncImage(it, item.name, graph.imageLoader, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
    }
}
