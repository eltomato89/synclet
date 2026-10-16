package tech.jensk.synclet.ui.components

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.ErrorCodes
import tech.jensk.synclet.core.api.NameRules
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.upload.UploadFailure

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ErrorMessagesTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private fun http(status: Int, code: String? = null) = SyncError.Http(status, code, null)

    @Test fun mapsStatusAndCode() {
        val c = context
        assertEquals("Changed in the meantime", c.syncErrorMessage(http(412, ErrorCodes.CONFLICT)))
        assertEquals("No longer available", c.syncErrorMessage(http(404)))
        assertEquals(c.getString(R.string.error_name_taken), c.syncErrorMessage(http(409, ErrorCodes.NAME_CONFLICT)))
        assertEquals("Storage full", c.syncErrorMessage(http(507, ErrorCodes.INSUFFICIENT_STORAGE)))
        assertEquals(c.getString(R.string.error_space_unavailable), c.syncErrorMessage(http(503, ErrorCodes.SPACE_UNAVAILABLE)))
        assertEquals(c.getString(R.string.error_forbidden), c.syncErrorMessage(http(403)))
        assertEquals(c.getString(R.string.error_sign_in_required), c.syncErrorMessage(SyncError.SignInRequired()))
        assertEquals(c.getString(R.string.error_sign_in_required), c.syncErrorMessage(http(401)))
        assertTrue(c.syncErrorMessage(SyncError.Http(500, null, "boom")).contains("500"))
    }

    @Test fun offline() {
        val error = SyncError.Transport(IOException())
        assertTrue(isOffline(error))
        assertTrue(context.syncErrorMessage(error).startsWith("Offline"))
    }

    @Test fun uploadFailures() {
        val c = context
        assertEquals("Storage full", c.uploadFailureMessage(UploadFailure.INSUFFICIENT_STORAGE))
        assertEquals("Destination folder deleted", c.uploadFailureMessage(UploadFailure.TARGET_GONE))
        assertEquals("Sign In Again", c.uploadFailureMessage(UploadFailure.SIGNED_OUT))
    }

    @Test fun nameProblemListsCharacters() {
        assertTrue(context.nameProblemMessage(NameRules.Problem.FORBIDDEN_CHARACTER).contains("< > : \" / \\ | ? *"))
    }

    @Test @Config(sdk = [35], qualifiers = "de") fun german() {
        val c = context
        assertEquals("Wurde inzwischen geändert", c.syncErrorMessage(http(412, ErrorCodes.CONFLICT)))
        assertEquals("Nicht mehr vorhanden", c.syncErrorMessage(http(404)))
        assertEquals("Speicher voll", c.syncErrorMessage(http(507)))
        assertEquals("Zielordner gelöscht", c.uploadFailureMessage(UploadFailure.TARGET_GONE))
    }
}
