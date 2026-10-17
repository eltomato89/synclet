package tech.jensk.synclet.ui.browser

import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.SyncItem
import tech.jensk.synclet.ui.TestTags

/** The per-item "⋮" menu; only actions the item's capabilities allow. Nothing allowed: no button. */
@Composable
fun ItemMenu(
    item: SyncItem, canShareLink: Boolean, onRename: () -> Unit, onMove: () -> Unit, onDelete: () -> Unit,
    onShareLink: () -> Unit,
) {
    val caps = item.capabilities
    if (!caps.rename && !caps.move && !caps.delete && !canShareLink) return
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag(TestTags.itemMenu(item.name))) {
            Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(R.string.browser_more_actions))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (caps.rename) MenuEntry(R.string.browser_rename, Icons.Outlined.DriveFileRenameOutline, TestTags.RENAME) { open = false; onRename() }
            if (caps.move) MenuEntry(R.string.browser_move, Icons.AutoMirrored.Outlined.DriveFileMove, TestTags.MOVE) { open = false; onMove() }
            if (caps.delete) MenuEntry(R.string.browser_delete, Icons.Outlined.Delete, TestTags.DELETE) { open = false; onDelete() }
            if (canShareLink) MenuEntry(R.string.browser_share_link, Icons.Outlined.Link, TestTags.SHARE_LINK) { open = false; onShareLink() }
        }
    }
}

@Composable
private fun MenuEntry(label: Int, icon: ImageVector, tag: String, onClick: () -> Unit) = DropdownMenuItem(
    text = { Text(stringResource(label)) },
    leadingIcon = { Icon(icon, contentDescription = null) },
    onClick = onClick,
    modifier = Modifier.testTag(tag),
)
