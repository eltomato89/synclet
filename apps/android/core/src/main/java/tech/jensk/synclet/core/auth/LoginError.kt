package tech.jensk.synclet.core.auth

sealed class LoginError(message: String) : Exception(message) {
    object InvalidAddress : LoginError("invalid server address")
    object InsecureAddress : LoginError("http is not allowed")
    class NotSynclet(val host: String) : LoginError("no Synclet server at $host")
    class Unreachable(val host: String) : LoginError("$host cannot be reached")
    object StateMismatch : LoginError("state mismatch")
    class Denied(val reason: String) : LoginError("sign-in refused: $reason")
    object MissingCode : LoginError("redirect without code")
    object Expired : LoginError("sign-in expired")
}
