package tech.jensk.synclet.core.api

/** Search snippets mark hits with « and » (SYNC_API search). */
object SearchSnippet {
    data class Segment(val text: String, val highlighted: Boolean)

    fun parse(snippet: String): List<Segment> {
        val result = mutableListOf<Segment>()
        val current = StringBuilder()
        var highlighted = false
        fun flush() {
            if (current.isNotEmpty()) result += Segment(current.toString(), highlighted)
            current.setLength(0)
        }
        for (c in snippet) {
            when (c) {
                '«' -> { flush(); highlighted = true }
                '»' -> { flush(); highlighted = false }
                else -> current.append(c)
            }
        }
        flush()
        return result
    }
}
