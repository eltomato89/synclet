package tech.jensk.synclet.core.api

import java.text.Normalizer

/** Client-side pre-check of SYNC_API §4.3 (the server stays authoritative). */
object NameRules {
    enum class Problem { EMPTY, DOT, FORBIDDEN_CHARACTER, TRAILING_SPACE_OR_DOT, RESERVED, TOO_LONG, IGNORED }

    private const val FORBIDDEN = "<>:\"/\\|?*"
    private val RESERVED = Regex("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..*)?$", RegexOption.IGNORE_CASE)
    private val IGNORED = setOf(".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".localized",
        "Thumbs.db", "desktop.ini", "\$RECYCLE.BIN", "@eaDir", "#recycle", "lost+found")
    private val IGNORED_PATTERNS = listOf(Regex("^\\._.*"), Regex("^~\\$.*"), Regex("^~WRL.*\\.tmp$"),
        Regex("^\\.~lock\\..*#$"), Regex("^\\.synclet-tmp-.*"), Regex("^\\.synclet-trash-.*"))

    fun check(name: String): Problem? = when {
        name.isEmpty() -> Problem.EMPTY
        name == "." || name == ".." -> Problem.DOT
        name.any { it in FORBIDDEN || it.code < 0x20 } -> Problem.FORBIDDEN_CHARACTER
        name.endsWith(' ') || name.endsWith('.') -> Problem.TRAILING_SPACE_OR_DOT
        RESERVED.matches(name) -> Problem.RESERVED
        Normalizer.normalize(name, Normalizer.Form.NFC).toByteArray(Charsets.UTF_8).size > 255 -> Problem.TOO_LONG
        name in IGNORED || IGNORED_PATTERNS.any { it.matches(name) } -> Problem.IGNORED
        else -> null
    }

    fun sanitize(name: String): String =
        Normalizer.normalize(name.map { if (it in FORBIDDEN || it.code < 0x20) '_' else it }.joinToString("").trim(), Normalizer.Form.NFC)
}
