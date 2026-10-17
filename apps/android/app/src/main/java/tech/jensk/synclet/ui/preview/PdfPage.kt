package tech.jensk.synclet.ui.preview

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.components.syncErrorMessage

private class PdfDoc(file: File) {
    private val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val renderer = try { PdfRenderer(fd) } catch (e: Throwable) { runCatching { fd.close() }; throw e }
    private val lock = Mutex()
    val pageCount: Int get() = renderer.pageCount

    /** Returns the rendered bitmap and the page's aspect ratio (w/h). */
    suspend fun render(index: Int, widthPx: Int): Bitmap = lock.withLock {
        withContext(Dispatchers.IO) {
            renderer.openPage(index).use { page ->
                val height = (widthPx.toFloat() * page.height / page.width).toInt().coerceAtLeast(1)
                val bitmap = Bitmap.createBitmap(widthPx, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bitmap
            }
        }
    }

    suspend fun size(index: Int): Pair<Int, Int> = lock.withLock {
        withContext(Dispatchers.IO) { renderer.openPage(index).use { it.width to it.height } }
    }

    /** Closes under the render lock so an in-flight render never races the native renderer. */
    suspend fun close() = withContext(NonCancellable) {
        lock.withLock { runCatching { renderer.close() }; runCatching { fd.close() } }
    }
}

@Composable
fun PdfPage(vm: PreviewViewModel, item: SyncItem, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var doc by remember(item.id) { mutableStateOf<PdfDoc?>(null) }
    var error by remember(item.id) { mutableStateOf<Throwable?>(null) }
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(item.id) {
        var created: PdfDoc? = null
        try {
            val file = vm.original(item)
            created = withContext(Dispatchers.IO) { PdfDoc(file) }
            // A cancellation between creation and assignment would leak the native renderer.
            currentCoroutineContext().ensureActive()
            doc = created
            created = null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e
        } finally {
            created?.close()
        }
    }
    DisposableEffect(item.id) {
        onDispose { doc?.let { d -> CoroutineScope(Dispatchers.IO + NonCancellable).launch { d.close() } } }
    }

    val current = doc
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when {
            error != null -> Text(context.syncErrorMessage(error!!))
            current == null -> LoadingProgress(state.progress[item.id])
            else -> BoxWithConstraints(Modifier.fillMaxSize()) {
                val widthPx = with(androidx.compose.ui.platform.LocalDensity.current) { maxWidth.roundToPx() }.coerceAtLeast(1)
                LazyColumn(Modifier.fillMaxSize()) {
                    items((0 until current.pageCount).toList()) { index ->
                        PdfPageImage(current, index, widthPx)
                    }
                }
            }
        }
    }
}

@Composable
private fun PdfPageImage(doc: PdfDoc, index: Int, widthPx: Int) {
    var bitmap by remember(doc, index, widthPx) { mutableStateOf<Bitmap?>(null) }
    var ratio by remember(doc, index) { mutableStateOf(0.707f) }
    LaunchedEffect(doc, index, widthPx) {
        runCatching { doc.size(index).let { (w, h) -> ratio = w.toFloat() / h } }
        bitmap = runCatching { doc.render(index, widthPx) }.getOrNull()
    }
    Box(Modifier.fillMaxWidth().aspectRatio(ratio).padding(bottom = 4.dp)) {
        bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize()) }
    }
}
