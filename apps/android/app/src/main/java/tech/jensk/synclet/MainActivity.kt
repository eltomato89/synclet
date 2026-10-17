package tech.jensk.synclet

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import tech.jensk.synclet.login.LoginActivity
import tech.jensk.synclet.ui.AppScaffold
import tech.jensk.synclet.ui.WelcomeScreen
import tech.jensk.synclet.ui.theme.SyncletTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as SyncletApp).graph
        setContent {
            SyncletTheme {
                // null = loading, false = startup failed (unreadable data): offer the sign-in instead of crashing.
                val ready by produceState<Boolean?>(null) {
                    value = try { graph.awaitReady(); true } catch (e: CancellationException) { throw e } catch (e: Exception) {
                        Log.e("Synclet", "startup failed: ${e.javaClass.simpleName}")
                        false
                    }
                }
                val accounts by graph.accounts.accounts.collectAsStateWithLifecycle()
                RequestNotificationPermissionOnce()
                when {
                    ready == null -> Box(Modifier.fillMaxSize())
                    ready == false || accounts.isEmpty() -> WelcomeScreen(onSignIn = { startActivity(Intent(this, LoginActivity::class.java)) })
                    else -> AppScaffold(graph)
                }
            }
        }
    }
}

/** Upload progress lives in notifications: ask once per process on API 33+; a refusal is accepted. */
@Composable
private fun RequestNotificationPermissionOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted && !NotificationPermission.asked) {
            NotificationPermission.asked = true
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

private object NotificationPermission { @Volatile var asked = false }
