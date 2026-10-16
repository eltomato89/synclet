package tech.jensk.synclet.ui.more

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import tech.jensk.synclet.R
import tech.jensk.synclet.ui.TestTags

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MoreScreen(onTrash: () -> Unit, onUploads: () -> Unit, onAccounts: () -> Unit, onSettings: () -> Unit) {
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.nav_more)) }) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            Entry(R.string.nav_trash, Icons.Outlined.Delete, TestTags.MORE_TRASH, onTrash)
            Entry(R.string.nav_uploads, Icons.Outlined.CloudUpload, TestTags.MORE_UPLOADS, onUploads)
            Entry(R.string.accounts_title, Icons.Outlined.ManageAccounts, TestTags.MORE_ACCOUNTS, onAccounts)
            Entry(R.string.settings_title, Icons.Outlined.Settings, TestTags.MORE_SETTINGS, onSettings)
        }
    }
}

@Composable
private fun Entry(label: Int, icon: ImageVector, tag: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(stringResource(label)) },
        leadingContent = { Icon(icon, contentDescription = null) },
        modifier = Modifier.testTag(tag).clickable(onClick = onClick),
    )
}
