package tech.jensk.synclet.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AudioFile
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.core.api.SyncSpace

fun iconFor(item: SyncItem): ImageVector = when {
    item.isSpaceRoot -> if (item.id == SyncItem.ROOT_ID) Icons.Outlined.Person else Icons.Outlined.Group
    item.isFolder -> Icons.Outlined.Folder
    else -> when (item.preview?.kind ?: item.kind) {
        "image" -> Icons.Outlined.Image
        "video" -> Icons.Outlined.Movie
        "audio" -> Icons.Outlined.AudioFile
        "pdf" -> Icons.Outlined.PictureAsPdf
        "text", "markdown" -> Icons.Outlined.Description
        "code" -> Icons.Outlined.Code
        else -> Icons.Outlined.InsertDriveFile
    }
}

fun spaceIcon(space: SyncSpace): ImageVector = when (space.kind) {
    "personal" -> Icons.Outlined.Person
    "external" -> Icons.Outlined.Storage
    else -> Icons.Outlined.Group
}

@Composable
fun ItemIcon(item: SyncItem, modifier: Modifier = Modifier) {
    Icon(iconFor(item), contentDescription = null, modifier = modifier.size(24.dp),
        tint = if (item.isFolder) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}
