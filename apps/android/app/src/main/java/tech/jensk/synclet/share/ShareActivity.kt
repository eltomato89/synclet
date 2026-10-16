package tech.jensk.synclet.share

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import tech.jensk.synclet.R
import tech.jensk.synclet.SyncletApp
import tech.jensk.synclet.login.LoginActivity
import tech.jensk.synclet.ui.theme.SyncletTheme

class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val graph = (application as SyncletApp).graph
        val payload = ShareIntentParser.parse(intent)
        if (payload == SharePayload.Empty) { finish(); return }
        setContent {
            SyncletTheme {
                val ready by produceState(false) { graph.awaitReady(); value = true }
                if (ready) ShareScreen(graph, payload,
                    onSignIn = { startActivity(Intent(this, LoginActivity::class.java)); finish() },
                    onDone = { count ->
                        Toast.makeText(this, resources.getQuantityString(R.plurals.share_queued, count, count), Toast.LENGTH_SHORT).show()
                        finish()
                    },
                    onCancel = { finish() })
            }
        }
    }
}
