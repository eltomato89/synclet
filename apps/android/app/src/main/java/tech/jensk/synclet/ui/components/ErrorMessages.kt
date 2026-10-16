package tech.jensk.synclet.ui.components

import android.content.Context
import tech.jensk.synclet.R
import tech.jensk.synclet.core.api.ErrorCodes
import tech.jensk.synclet.core.api.NameRules
import tech.jensk.synclet.core.api.SyncError
import tech.jensk.synclet.core.api.isAuthFailure
import tech.jensk.synclet.core.upload.UploadFailure

fun isOffline(error: Throwable): Boolean = error is SyncError.Transport

fun Context.syncErrorMessage(error: Throwable): String = when {
    error is SyncError.Transport -> getString(R.string.error_offline)
    error.isAuthFailure -> getString(R.string.error_sign_in_required)
    error is SyncError.Http -> when {
        error.status == 412 || (error.status == 409 && error.code == ErrorCodes.CONFLICT) -> getString(R.string.error_changed)
        error.status == 404 -> getString(R.string.error_gone)
        error.code == ErrorCodes.NAME_CONFLICT -> getString(R.string.error_name_taken)
        error.code == ErrorCodes.INVALID_NAME -> getString(R.string.error_invalid_name)
        error.code == ErrorCodes.INVALID_MOVE -> getString(R.string.error_invalid_move)
        error.status == 403 -> getString(R.string.error_forbidden)
        error.status == 507 -> getString(R.string.error_storage_full)
        error.code == ErrorCodes.SPACE_UNAVAILABLE -> getString(R.string.error_space_unavailable)
        error.status == 413 -> getString(R.string.error_too_large)
        error.status == 429 -> getString(R.string.error_rate_limited)
        else -> getString(R.string.error_server, error.status.toString())
    }
    else -> getString(R.string.error_unexpected)
}

fun Context.uploadFailureMessage(failure: UploadFailure?): String = getString(when (failure) {
    UploadFailure.INSUFFICIENT_STORAGE -> R.string.error_storage_full
    UploadFailure.TARGET_GONE -> R.string.upload_error_target_gone
    UploadFailure.SIGNED_OUT -> R.string.upload_error_signed_out
    UploadFailure.TOO_LARGE -> R.string.error_too_large
    UploadFailure.INVALID_NAME -> R.string.error_invalid_name
    UploadFailure.READ_ONLY -> R.string.error_forbidden
    UploadFailure.SPACE_UNAVAILABLE -> R.string.error_space_unavailable
    UploadFailure.NETWORK -> R.string.error_offline
    UploadFailure.SOURCE_MISSING -> R.string.upload_error_source_missing
    UploadFailure.OTHER, null -> R.string.error_unexpected
})

fun Context.nameProblemMessage(problem: NameRules.Problem): String = getString(when (problem) {
    NameRules.Problem.EMPTY -> R.string.name_error_empty
    NameRules.Problem.DOT -> R.string.name_error_dot
    NameRules.Problem.FORBIDDEN_CHARACTER -> R.string.name_error_character
    NameRules.Problem.TRAILING_SPACE_OR_DOT -> R.string.name_error_trailing
    NameRules.Problem.RESERVED -> R.string.name_error_reserved
    NameRules.Problem.TOO_LONG -> R.string.name_error_too_long
    NameRules.Problem.IGNORED -> R.string.name_error_ignored
})
