package tech.jensk.synclet.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.TestTags

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ItemTile(
    item: SyncItem, imageLoader: ImageLoader, api: SyncApi, accountKey: String, selected: Boolean,
    selectionMode: Boolean, onClick: () -> Unit, onLongClick: () -> Unit,
    menu: (@Composable () -> Unit)? = null, modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick).testTag(TestTags.item(item.name)),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer
            else MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Column {
            Box(Modifier.fillMaxWidth().aspectRatio(if (item.isFolder) 4f / 3f else 1f), contentAlignment = Alignment.Center) {
                ThumbnailImage(imageLoader, api, accountKey, item, 256,
                    if (item.hasThumbnail || item.preview?.thumbnailKey != null) Modifier.fillMaxSize() else Modifier,
                    if (item.isFolder) ContentScale.Fit else ContentScale.Crop)
                if (selectionMode) Checkbox(checked = selected, onCheckedChange = null,
                    modifier = Modifier.align(Alignment.TopStart).padding(4.dp))
            }
            Row(Modifier.fillMaxWidth().padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween) {
                Text(item.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
                menu?.invoke()
            }
        }
    }
}
