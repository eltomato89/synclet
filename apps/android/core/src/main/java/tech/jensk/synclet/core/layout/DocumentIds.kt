package tech.jensk.synclet.core.layout

/** Provider document ids `<accountKey>/<syncId>`; the virtual top level is `<accountKey>/top` (Spec-Klärung 2). */
object DocumentIds {
    const val TOP = "top"
    private val SYNC_ID = Regex("^(top|root|[dfr]_[0-9a-f-]{36})$")

    data class Parsed(val accountKey: String, val syncId: String) { val isTop: Boolean get() = syncId == TOP }

    fun top(accountKey: String): String = "$accountKey/$TOP"
    fun of(accountKey: String, syncId: String): String = "$accountKey/$syncId"

    fun parse(documentId: String): Parsed? {
        val slash = documentId.lastIndexOf('/')
        if (slash <= 0 || slash == documentId.length - 1) return null
        val syncId = documentId.substring(slash + 1)
        if (!SYNC_ID.matches(syncId)) return null
        return Parsed(documentId.substring(0, slash), syncId)
    }
}
