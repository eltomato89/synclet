package tech.jensk.synclet.core.upload

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** "<base> (<word> <device> <yyyy-MM-dd HH-mm>).<ext>" (SYNC_API §6.3; word localised). */
object ConflictNaming {
    private val FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH-mm", Locale.ROOT)
    private const val BAD = "/\\:<>\"|?*"

    fun name(original: String, device: String, word: String, time: ZonedDateTime): String {
        val (base, ext) = split(original)
        val suffix = " ($word ${sanitizedDevice(device)} ${FORMAT.format(time)})"
        val tail = ext?.let { ".$it" } ?: ""
        var b = base
        while ((b + suffix + tail).toByteArray(Charsets.UTF_8).size > 255 && b.isNotEmpty()) {
            b = b.dropLast(if (b.length >= 2 && Character.isLowSurrogate(b.last())) 2 else 1)
        }
        return b + suffix + tail
    }

    /** Base and extension at the last dot; a leading dot, a trailing dot or no dot → no extension. */
    fun split(name: String): Pair<String, String?> {
        val dot = name.lastIndexOf('.')
        return if (dot <= 0 || dot == name.length - 1) name to null else name.substring(0, dot) to name.substring(dot + 1)
    }

    fun sanitizedDevice(name: String): String =
        name.map { if (it in BAD || it.code < 0x20) '-' else it }.joinToString("").trim().ifEmpty { "Android" }
}
