package tech.jensk.synclet.live

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assume.assumeTrue
import tech.jensk.synclet.AppGraph
import tech.jensk.synclet.SyncletApp
import tech.jensk.synclet.core.account.AccountSession
import tech.jensk.synclet.core.api.SyncItem

/**
 * Instrumented live tests run against the throwaway stack of scripts/android-live-tests.sh, which hands
 * the server (as seen from the emulator, http://10.0.2.2:<port>), a device token, the team folder name and
 * the user's credentials over as instrumentation arguments. Without them every live test skips itself.
 */
object LiveTestSupport {
    private val args get() = InstrumentationRegistry.getArguments()
    val server: String? get() = args.getString("syncletServer")?.takeIf { it.isNotBlank() }
    val token: String? get() = args.getString("syncletToken")?.takeIf { it.isNotBlank() }
    val team: String? get() = args.getString("syncletTeam")?.takeIf { it.isNotBlank() }
    val user: String? get() = args.getString("syncletUser")?.takeIf { it.isNotBlank() }
    val password: String? get() = args.getString("syncletPassword")?.takeIf { it.isNotBlank() }
    val context: Context get() = ApplicationProvider.getApplicationContext()
    val graph: AppGraph get() = (context as SyncletApp).graph

    fun requireServer() = assumeTrue("no live server (instrumentation args syncletServer/syncletToken)", server != null && token != null)

    suspend fun signIn(): AccountSession {
        requireServer()
        graph.awaitReady()
        val account = graph.accounts.addWithDeviceToken(server!!.toHttpUrl(), token!!)
        graph.settings.setSelectedAccount(account.key)
        return graph.session(account.key)!!
    }

    suspend fun scratchFolder(session: AccountSession, prefix: String): SyncItem =
        session.api.createFolder("root", "$prefix-${UUID.randomUUID().toString().take(8)}")

    fun waitUntil(timeoutMs: Long = 30_000, condition: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (!condition()) { check(SystemClock.uptimeMillis() < end) { "timed out" }; Thread.sleep(200) }
    }

    /**
     * A foreign `content://` source like the "+" menu's pickers hand over (AppGraph refuses file:// and the
     * app's own data): a Downloads entry in MediaStore, which needs no permission on API 29+.
     */
    fun mediaStoreFile(name: String, mime: String, bytes: ByteArray): Uri {
        val cr = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
        cr.openOutputStream(uri, "w")!!.use { it.write(bytes) }
        cr.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return uri
    }

    fun deleteMediaStoreFile(uri: Uri) { runCatching { context.contentResolver.delete(uri, null, null) } }
}
