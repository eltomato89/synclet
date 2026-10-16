package tech.jensk.synclet.ui.browser

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.UploadFile
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import tech.jensk.synclet.R
import tech.jensk.synclet.ui.TestTags

/** "+" button: photos & videos (system photo picker), files (document picker), new folder. */
@Composable
fun AddMenu(onUris: (List<Uri>) -> Unit, onNewFolder: () -> Unit, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    val media = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isNotEmpty()) onUris(uris)
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) onUris(uris)
    }
    Box(modifier) {
        FloatingActionButton(onClick = { open = true }, modifier = Modifier.testTag(TestTags.ADD_MENU)) {
            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.browser_add))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.browser_upload_media)) },
                leadingIcon = { Icon(Icons.Outlined.PhotoLibrary, contentDescription = null) },
                onClick = {
                    open = false
                    media.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                },
                modifier = Modifier.testTag(TestTags.UPLOAD_MEDIA),
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.browser_upload_files)) },
                leadingIcon = { Icon(Icons.Outlined.UploadFile, contentDescription = null) },
                onClick = { open = false; files.launch(arrayOf("*/*")) },
                modifier = Modifier.testTag(TestTags.UPLOAD_FILES),
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.browser_new_folder)) },
                leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, contentDescription = null) },
                onClick = { open = false; onNewFolder() },
                modifier = Modifier.testTag(TestTags.NEW_FOLDER),
            )
        }
    }
}
