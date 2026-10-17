package tech.jensk.synclet.live

import android.content.Intent
import android.net.Uri
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.auth.BrowserLogin
import tech.jensk.synclet.core.auth.Pkce
import tech.jensk.synclet.core.upload.UploadFailure
import tech.jensk.synclet.core.upload.UploadStatus
import tech.jensk.synclet.login.LoginActivity
import tech.jensk.synclet.login.PendingLogin
import tech.jensk.synclet.login.PendingLoginStore

/**
 * The browser-login redirect path end to end without the browser: the test plays the web page's part
 * (`POST /api/auth/app/authorize` with the user's password and the PKCE challenge), the app gets the
 * `synclet://oauth?code=…&state=…` intent. The pending login is written to disk by the test, not by the
 * activity's view model, so only the persisted state can complete it (as after a process death).
 *
 * Also covers AppGraph.resumeAfterSignIn: an upload stopped with SIGNED_OUT (device revoked on the server)
 * goes out after the re-sign-in without anyone touching it.
 */
@RunWith(AndroidJUnit4::class)
class LoginRedirectLiveTest {
    private val graph get() = LiveTestSupport.graph
    private val origin: HttpUrl get() = LiveTestSupport.server!!.toHttpUrl()

    private fun requireCredentials() {
        LiveTestSupport.requireServer()
        assumeTrue("no credentials (instrumentation args syncletUser/syncletPassword)",
            LiveTestSupport.user != null && LiveTestSupport.password != null)
    }

    /** What the web page does after the password form: a one-time code bound to the PKCE challenge. */
    private suspend fun authorize(challenge: String): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("login", LiveTestSupport.user).put("password", LiveTestSupport.password)
            .put("clientId", "android").put("redirectUri", "synclet://oauth")
            .put("codeChallenge", challenge).put("codeChallengeMethod", "S256").toString()
        val request = Request.Builder().url(origin.newBuilder().encodedPath("/api/auth/app/authorize").build())
            .post(body.toRequestBody("application/json".toMediaType())).build()
        graph.http.newCall(request).execute().use { response ->
            check(response.code == 200) { "authorize: HTTP ${response.code}" }
            JSONObject(response.body.string()).getString("code")
        }
    }

    /** A pending login on disk, as LoginViewModel.prepare leaves it before the Custom Tab opens. */
    private suspend fun pendingRedirect(): Uri {
        val pkce = Pkce.create()
        PendingLoginStore(File(LiveTestSupport.context.noBackupFilesDir, "pending-login.json"))
            .save(PendingLogin(origin.toString(), pkce.verifier, pkce.state, LiveTestSupport.user, System.currentTimeMillis()))
        val code = authorize(pkce.challenge)
        return Uri.parse("synclet://oauth").buildUpon().appendQueryParameter("code", code).appendQueryParameter("state", pkce.state).build()
    }

    private fun redirectIntent(uri: Uri) = Intent(Intent.ACTION_VIEW, uri)
        .setPackage(LiveTestSupport.context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** An account on its own, freshly registered device (the shared test token must not be revoked). */
    private suspend fun signInWithOwnDevice(): AccountSession {
        graph.awaitReady()
        val pkce = Pkce.create()
        val tokens = BrowserLogin(graph.http).exchangeCode(origin, authorize(pkce.challenge), pkce.verifier)
        val account = graph.accounts.completeBrowserLogin(origin, tokens)
        graph.settings.setSelectedAccount(account.key)
        return graph.session(account.key)!!
    }

    @Test fun redirectIntoRestoredActivityViaOnNewIntentSignsInAgainAndResumesUploads() = runBlocking<Unit> {
        requireCredentials()
        val session = signInWithOwnDevice()
        val key = session.key
        val folder = LiveTestSupport.scratchFolder(session, "relogin")
        val name = "relogin-${UUID.randomUUID().toString().take(6)}.txt"
        val source = LiveTestSupport.mediaStoreFile(name, "text/plain", "after sign-in".toByteArray())
        try {
            // The device is revoked behind the app's back: the next upload hits 401 and stops as SIGNED_OUT.
            session.api.revokeCurrentDevice()
            val oldToken = session.api.currentToken()
            graph.enqueueUploads(key, folder.id, folder.name, listOf(source))
            val entryId = graph.uploadQueue.entries.value.last { it.parentId == folder.id }.id
            LiveTestSupport.waitUntil(60_000) {
                graph.uploadQueue.entries.value.firstOrNull { it.id == entryId }?.failure == UploadFailure.SIGNED_OUT
            }
            LiveTestSupport.waitUntil { graph.accounts.accounts.value.first { it.key == key }.needsSignIn }

            // "Sign in again" opened the login screen; the system then restores it (savedInstanceState != null),
            // and the browser's redirect reaches the existing singleTask instance through onNewIntent.
            val redirect = pendingRedirect()
            val scenario = ActivityScenario.launch<LoginActivity>(Intent(LiveTestSupport.context, LoginActivity::class.java)
                .putExtra(LoginActivity.EXTRA_SERVER, origin.toString()).putExtra(LoginActivity.EXTRA_LOGIN_HINT, LiveTestSupport.user))
            scenario.recreate()
            LiveTestSupport.context.startActivity(redirectIntent(redirect))

            LiveTestSupport.waitUntil(60_000) { !graph.accounts.accounts.value.first { it.key == key }.needsSignIn }
            assertNotEquals(oldToken, graph.session(key)!!.api.currentToken())
            // resumeAfterSignIn: the SIGNED_OUT entry is retried and scheduled; the worker uploads it.
            LiveTestSupport.waitUntil(60_000) {
                graph.uploadQueue.entries.value.firstOrNull { it.id == entryId }?.status == UploadStatus.DONE
            }
            val uploaded = graph.session(key)!!.api.allChildren(folder.id)
            assertEquals(listOf(name), uploaded.map { it.name })
            // The pending login was consumed, the login screen finished.
            assertTrue(!File(LiveTestSupport.context.noBackupFilesDir, "pending-login.json").exists())
            LiveTestSupport.waitUntil { scenario.state == Lifecycle.State.DESTROYED }
        } finally {
            LiveTestSupport.deleteMediaStoreFile(source)
            runCatching { graph.session(key)!!.api.deleteItem(folder.id) }
        }
    }

    @Test fun redirectIntoFreshActivityCompletesLogin() = runBlocking<Unit> {
        requireCredentials()
        val session = signInWithOwnDevice()
        val key = session.key
        val before = session.api.currentToken()
        // No login screen around (e.g. the process and its task were gone): the redirect starts the activity itself.
        val scenario = ActivityScenario.launch<LoginActivity>(redirectIntent(pendingRedirect()).setClass(LiveTestSupport.context, LoginActivity::class.java))
        LiveTestSupport.waitUntil(60_000) { graph.session(key)!!.api.currentToken() != before }
        assertTrue(!graph.accounts.accounts.value.first { it.key == key }.needsSignIn)
        graph.session(key)!!.api.account()          // the new device token works
        LiveTestSupport.waitUntil { scenario.state == Lifecycle.State.DESTROYED }
    }
}
