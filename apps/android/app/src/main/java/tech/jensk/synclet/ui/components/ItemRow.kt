package tech.jensk.synclet.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import tech.jensk.synclet.core.api.SyncApi
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.TestTags

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ItemRow(
    item: SyncItem, imageLoader: ImageLoader, api: SyncApi, accountKey: String, selected: Boolean,
    selectionMode: Boolean, onClick: () -> Unit, onLongClick: () -> Unit, subtitle: String? = null,
    menu: (@Composable () -> Unit)? = null, modifier: Modifier = Modifier,
) {
    val supporting = subtitle ?: if (item.isFolder) formatDate(item.modifiedAt)
        else "${formatDate(item.modifiedAt)} · ${formatBytes(item.size)}"
    ListItem(
        modifier = modifier.combinedClickable(onClick = onClick, onLongClick = onLongClick).testTag(TestTags.item(item.name)),
        colors = ListItemDefaults.colors(
            containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface),
        leadingContent = {
            Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                if (selectionMode) Checkbox(checked = selected, onCheckedChange = null)
                else ThumbnailImage(imageLoader, api, accountKey, item, 96,
                    Modifier.size(40.dp).clip(RoundedCornerShape(6.dp)))
            }
        },
        headlineContent = { Text(item.name, maxLines = 1, overflow = TextOverflow.MiddleEllipsis) },
        supportingContent = { Text(supporting, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingContent = menu,
    )
}
