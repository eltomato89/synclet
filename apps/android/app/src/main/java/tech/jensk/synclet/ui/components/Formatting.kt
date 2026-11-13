package tech.jensk.synclet.ui.components

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

fun formatBytes(bytes: Long, locale: Locale = Locale.getDefault()): String {
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes / 1024.0
    var unit = 0
    // Step up once the value would round to 1024.0 (1048575 B is "1.0 MB", not "1024.0 KB").
    while (value >= 1023.95 && unit < units.lastIndex) { value /= 1024; unit++ }
    return String.format(locale, "%.1f %s", value, units[unit])
}

/** Formatters are immutable; one per locale instead of a new one for every row. */
private val dateFormatters = java.util.concurrent.ConcurrentHashMap<Locale, DateTimeFormatter>()

fun formatDate(iso: String, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String =
    runCatching {
        dateFormatters.getOrPut(locale) { DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale) }
            .format(Instant.parse(iso).atZone(zone))
    }.getOrDefault(iso)
