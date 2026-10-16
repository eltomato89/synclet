package tech.jensk.synclet.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import coil3.ImageLoader
import coil3.compose.AsyncImage
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.cache.ThumbnailCache

@Composable
fun ThumbnailImage(
    imageLoader: ImageLoader, api: SyncApi, accountKey: String, item: SyncItem, size: Int = 256,
    modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop,
) {
    val context = LocalContext.current
    val request = remember(item.id, item.sha256, item.preview?.thumbnailKey, size) {
        ThumbnailCache.request(context, api, accountKey, item, size)
    }
    if (request == null) {
        ItemIcon(item, modifier)
    } else {
        AsyncImage(
            model = request, imageLoader = imageLoader, contentDescription = null, modifier = modifier,
            contentScale = contentScale, error = rememberVectorPainter(iconFor(item)),
        )
    }
}
