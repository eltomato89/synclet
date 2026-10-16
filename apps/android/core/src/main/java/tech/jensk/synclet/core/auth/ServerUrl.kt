package tech.jensk.synclet.core.auth

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerUrl {
    /** Origin of what the user typed: https added when no scheme is given; path, query, fragment dropped. */
    fun normalize(input: String, allowHttp: Boolean): HttpUrl {
        val text = input.trim()
        if (text.isEmpty() || text.any { it.isWhitespace() }) throw LoginError.InvalidAddress
        val parsed = (if ("://" in text) text else "https://$text").toHttpUrlOrNull() ?: throw LoginError.InvalidAddress
        if (parsed.host.isEmpty()) throw LoginError.InvalidAddress
        if (parsed.scheme == "http" && !allowHttp) throw LoginError.InsecureAddress
        return HttpUrl.Builder().scheme(parsed.scheme).host(parsed.host).port(parsed.port).build()
    }

    fun display(url: HttpUrl): String =
        if (url.port == HttpUrl.defaultPort(url.scheme)) url.host else "${url.host}:${url.port}"
}
