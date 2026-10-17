package tech.jensk.synclet.login

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import tech.jensk.synclet.MainActivity
import tech.jensk.synclet.SyncletApp

/** Debug builds only: sign in with an existing device token (instrumented tests, live-test --serve). */
class DebugLoginActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val server = intent.getStringExtra("server")
        val token = intent.getStringExtra("token")
        if (server == null || token == null) { finish(); return }
        val graph = (application as SyncletApp).graph
        lifecycleScope.launch {
            try {
                graph.awaitReady()
                val account = graph.accounts.addWithDeviceToken(server.toHttpUrl(), token)
                graph.settings.setSelectedAccount(account.key)
                startActivity(Intent(this@DebugLoginActivity, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            } catch (e: Exception) {
                Log.e("SyncletDebugLogin", "debug sign-in failed: ${e.javaClass.simpleName}")
            } finally {
                finish()
            }
        }
    }
}
