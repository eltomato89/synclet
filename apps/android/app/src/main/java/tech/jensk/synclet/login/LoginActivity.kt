package tech.jensk.synclet.login

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.File
import okhttp3.HttpUrl
import tech.jensk.synclet.BuildConfig
import tech.jensk.synclet.MainActivity
import tech.jensk.synclet.SyncletApp
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.ServerCheck
import tech.jensk.synclet.ui.theme.SyncletTheme

/** Server entry, Custom Tab sign-in and the synclet://oauth redirect (also into a freshly started process). */
class LoginActivity : ComponentActivity() {
    private val graph get() = (application as SyncletApp).graph
    private val vm: LoginViewModel by viewModels {
        viewModelFactory {
            initializer {
                LoginViewModel(ServerCheck(graph.http), BrowserLogin(graph.http), graph.accounts,
                    PendingLoginStore(File(noBackupFilesDir, "pending-login.json")), allowHttp = BuildConfig.DEBUG,
                    ready = { graph.awaitReady() })
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreated activity (rotation, process restore) must not hand the same redirect in a second time.
        if (savedInstanceState == null) handle(intent)
        val prefill = intent.getStringExtra(EXTRA_SERVER)
        val hint = intent.getStringExtra(EXTRA_LOGIN_HINT)
        setContent {
            SyncletTheme {
                LoginScreen(vm, prefillServer = prefill, loginHint = hint, onOpenBrowser = ::openBrowser, onDone = {
                    startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    finish()
                })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "synclet" && data.host == "oauth") vm.complete(data.toString())
    }

    private fun openBrowser(url: HttpUrl) {
        val uri = Uri.parse(url.toString())
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, uri)
        } catch (e: ActivityNotFoundException) {
            try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (e2: ActivityNotFoundException) { vm.reportNoBrowser() }
        }
    }

    companion object {
        const val EXTRA_SERVER = "server"
        const val EXTRA_LOGIN_HINT = "loginHint"
    }
}
