package tech.jensk.synclet.share

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import kotlinx.coroutines.CancellationException
import tech.jensk.synclet.R
import tech.jensk.synclet.SyncletApp
import tech.jensk.synclet.login.LoginActivity
import tech.jensk.synclet.ui.WelcomeScreen
import tech.jensk.synclet.ui.theme.SyncletTheme

class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = (application as SyncletApp).graph
        val payload = ShareIntentParser.parse(intent)
        if (payload == SharePayload.Empty) { finish(); return }
        val signIn = { startActivity(Intent(this, LoginActivity::class.java)); finish() }
        setContent {
            SyncletTheme {
                // null = loading, false = startup failed (unreadable data): offer the sign-in instead of crashing.
                val ready by produceState<Boolean?>(null) { value = awaitStartup { graph.awaitReady() } }
                when (ready) {
                    null -> Box(Modifier.fillMaxSize())
                    false -> WelcomeScreen(onSignIn = signIn)
                    true -> ShareScreen(graph, payload,
                        onSignIn = signIn,
                        onDone = { count ->
                            Toast.makeText(this, resources.getQuantityString(R.plurals.share_queued, count, count), Toast.LENGTH_SHORT).show()
                            finish()
                        },
                        onCancel = { finish() })
                }
            }
        }
    }
}

/** True once the app is ready, false when its startup failed; never throws into the composition (cancellation aside). */
internal suspend fun awaitStartup(ready: suspend () -> Unit): Boolean = try {
    ready()
    true
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Log.e("Synclet", "startup failed: ${e.javaClass.simpleName}")
    false
}
