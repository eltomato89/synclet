package tech.jensk.synclet.ui.preview

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CancellationException
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import tech.jensk.synclet.R
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
    var failed by remember(item.id) { mutableStateOf(false) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    LaunchedEffect(item.id) {
        try {
            original = vm.original(item)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed = true
        }
    }
    LaunchedEffect(scale) { onZoomChanged(scale > 1f) }

    val thumb = remember(item.id) {
        graph.session(accountKey)?.let { ThumbnailCache.request(context, it.api, accountKey, item, 1024) }
    }
    Box(
        modifier.fillMaxSize().onSizeChanged { size = it }
            .pointerInput(item.id) {
                detectTapGestures(onDoubleTap = {
                    if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f
                    offset = clampPan(offset, scale, size)
                })
            }
            .pointerInput(item.id) {
                // Single-finger drags pass through at 1x so the pager can swipe; only pinch or a zoomed drag is consumed.
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        val multi = event.changes.count { it.pressed } > 1
                        if (multi || scale > 1f) {
                            val zoom = event.calculateZoom()
                            val pan = event.calculatePan()
                            if (zoom != 1f || pan != Offset.Zero) {
                                scale = (scale * zoom).coerceIn(1f, 5f)
                                offset = if (scale == 1f) Offset.Zero else clampPan(offset + pan, scale, size)
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
    ) {
        if (thumb != null) {
            AsyncImage(thumb, item.name, graph.imageLoader, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        }
        if (failed && original == null) {
            Text(stringResource(R.string.preview_load_failed), Modifier.align(Alignment.BottomCenter))
        }
        original?.let { AsyncImage(it, item.name, graph.imageLoader, Modifier.fillMaxSize(), contentScale = ContentScale.Fit) }
    }
}

private fun clampPan(offset: Offset, scale: Float, size: IntSize): Offset {
    val maxX = size.width * (scale - 1f) / 2f
    val maxY = size.height * (scale - 1f) / 2f
    return Offset(offset.x.coerceIn(-maxX, maxX), offset.y.coerceIn(-maxY, maxY))
}
