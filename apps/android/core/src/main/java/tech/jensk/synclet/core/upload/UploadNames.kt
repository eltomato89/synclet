package tech.jensk.synclet.core.upload

import java.text.Normalizer
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A valid file name (SYNC_API §4.3) for content shared from other apps. */
object UploadNames {
    private val STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH-mm-ss", Locale.ROOT)
    private const val FORBIDDEN = "<>:\"\\|?*"
    private val RESERVED = Regex("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\..*)?$", RegexOption.IGNORE_CASE)
    private val IGNORED = setOf(".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems", ".localized",
        "Thumbs.db", "desktop.ini", "\$RECYCLE.BIN", "@eaDir", "#recycle", "lost+found")

    fun forShared(displayName: String?, mime: String?, now: ZonedDateTime, fallbackBase: String, extensionForMime: (String) -> String?): String {
        var name = (displayName ?: "").substringAfterLast('/')
            .map { if (it in FORBIDDEN || it.code < 0x20) '_' else it }.joinToString("")
            .trim().trimEnd('.', ' ')
        name = Normalizer.normalize(name, Normalizer.Form.NFC)
        if (name.isEmpty() || name == "." || name == "..") name = "$fallbackBase ${STAMP.format(now)}"
        if (ConflictNaming.split(name).second == null) mime?.let(extensionForMime)?.let { name = "$name.$it" }
        if (RESERVED.matches(name) || name in IGNORED || name.startsWith("._") || name.startsWith("~$") ||
            name.startsWith(".synclet-")) name = "_$name"
        while (name.toByteArray(Charsets.UTF_8).size > 255) {
            val (base, ext) = ConflictNaming.split(name)
            name = if (ext != null && base.length > 1) dropLastChar(base) + "." + ext else dropLastChar(name)
        }
        return name
    }

    /** Drops the last character, a surrogate pair as a whole. */
    private fun dropLastChar(s: String): String =
        s.dropLast(if (s.length >= 2 && Character.isLowSurrogate(s.last()) && Character.isHighSurrogate(s[s.length - 2])) 2 else 1)
}
