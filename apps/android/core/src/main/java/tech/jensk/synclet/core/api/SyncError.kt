package tech.jensk.synclet.core.api

import java.io.IOException

sealed class SyncError(message: String?, cause: Throwable? = null) : IOException(message, cause) {
    class Http(
        val status: Int, val code: String?, val serverMessage: String?,
        val item: SyncItem? = null, val retryAfterSeconds: Long? = null,
    ) : SyncError("HTTP $status${code?.let { " $it" } ?: ""}${serverMessage?.let { ": $it" } ?: ""}")
    class Transport(cause: IOException) : SyncError(cause.message ?: cause.javaClass.simpleName, cause)
    class InvalidResponse(detail: String, cause: Throwable? = null) : SyncError(detail, cause)
    class SignInRequired : SyncError("sign-in required")
}

object ErrorCodes {
    const val UNAUTHORIZED = "unauthorized"
    const val DEVICE_REVOKED = "device_revoked"
    const val FORBIDDEN = "forbidden"
    const val NOT_FOUND = "not_found"
    const val NAME_CONFLICT = "name_conflict"
    const val INVALID_MOVE = "invalid_move"
    const val INVALID_NAME = "invalid_name"
    const val INVALID_REQUEST = "invalid_request"
    const val CURSOR_EXPIRED = "cursor_expired"
    const val CONFLICT = "conflict"
    const val PRECONDITION_REQUIRED = "precondition_required"
    const val TOO_LARGE = "too_large"
    const val RANGE_NOT_SATISFIABLE = "range_not_satisfiable"
    const val INSUFFICIENT_STORAGE = "insufficient_storage"
    const val SPACE_UNAVAILABLE = "space_unavailable"
    const val RATE_LIMITED = "rate_limited"
}

val Throwable.isAuthFailure: Boolean
    get() = this is SyncError.SignInRequired || (this is SyncError.Http && status == 401)

fun Throwable.httpStatus(): Int? = (this as? SyncError.Http)?.status
fun Throwable.errorCode(): String? = (this as? SyncError.Http)?.code
