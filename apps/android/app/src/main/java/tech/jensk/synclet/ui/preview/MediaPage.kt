package tech.jensk.synclet.ui.preview

import android.view.ViewGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.TextButton
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CancellationException
import tech.jensk.synclet.R
import tech.jensk.synclet.ui.components.syncErrorMessage
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.components.iconFor

// PlayerView's controller settings are @UnstableApi in media3.
@OptIn(UnstableApi::class)
@Composable
fun MediaPage(vm: PreviewViewModel, item: SyncItem, isCurrent: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var attempt by remember(item.id) { mutableIntStateOf(0) }
    val urlResult by produceState<Result<String>?>(null, item.id, attempt) {
        value = null
        value = try { Result.success(vm.mediaUrl(item)) } catch (e: CancellationException) { throw e } catch (e: Exception) { Result.failure(e) }
    }
    val url = urlResult?.getOrNull()
    val owner = LocalLifecycleOwner.current
    val exo = remember(item.id) { ExoPlayer.Builder(context).build() }
    DisposableEffect(exo) { onDispose { exo.release() } }
    LaunchedEffect(url) {
        url?.let { exo.setMediaItem(MediaItem.fromUri(it)); exo.prepare() }
    }
    DisposableEffect(owner, exo) {
        val observer = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) exo.pause() }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(isCurrent) { if (!isCurrent) exo.pause() }

    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val failure = urlResult?.exceptionOrNull()
        if (failure != null) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(context.syncErrorMessage(failure))
                TextButton(onClick = { attempt++ }) { Text(stringResource(R.string.preview_retry)) }
            }
        } else if (url == null) {
            CircularProgressIndicator()
        } else {
            AndroidView(
                factory = { c ->
                    PlayerView(c).apply {
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        player = exo
                        if (PreviewKind.of(item) == PreviewKind.AUDIO) {
                            controllerShowTimeoutMs = 0
                            controllerHideOnTouch = false
                            showController()
                        }
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (PreviewKind.of(item) == PreviewKind.AUDIO) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(iconFor(item), null, Modifier.size(96.dp), tint = MaterialTheme.colorScheme.primary)
                Text(item.name, style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}
