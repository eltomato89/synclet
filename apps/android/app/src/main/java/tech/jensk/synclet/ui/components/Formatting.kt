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
    while (value >= 1024 && unit < units.lastIndex) { value /= 1024; unit++ }
    return String.format(locale, "%.1f %s", value, units[unit])
}

fun formatDate(iso: String, locale: Locale = Locale.getDefault(), zone: ZoneId = ZoneId.systemDefault()): String =
    runCatching {
        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale)
            .format(Instant.parse(iso).atZone(zone))
    }.getOrDefault(iso)
