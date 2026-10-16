package tech.jensk.synclet

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.res.stringResource
import tech.jensk.synclet.ui.theme.SyncletTheme

/** Placeholder; Task 8 replaces the content with the app navigation. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SyncletTheme { Surface { Text(stringResource(R.string.app_name)) } } }
    }
}
