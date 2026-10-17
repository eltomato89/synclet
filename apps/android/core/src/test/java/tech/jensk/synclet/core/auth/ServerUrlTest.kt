package tech.jensk.synclet.core.auth

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ServerUrlTest {
    @Test fun addsHttpsAndKeepsOnlyTheOrigin() {
        assertEquals("https://files.example.com/", ServerUrl.normalize("  Files.Example.com/sub/path?x=1#y ", false).toString())
        assertEquals("https://files.example.com:8443/", ServerUrl.normalize("https://files.example.com:8443", false).toString())
    }
    @Test fun httpOnlyWhenAllowed() {
        assertThrows(LoginError.InsecureAddress::class.java) { ServerUrl.normalize("http://10.0.2.2:8080", false) }
        assertEquals("http://10.0.2.2:8080/", ServerUrl.normalize("http://10.0.2.2:8080", true).toString())
    }
    @Test fun rejectsGarbage() {
        for (bad in listOf("", "  ", "a b", "ftp://x.example", "https://")) {
            assertThrows(LoginError.InvalidAddress::class.java) { ServerUrl.normalize(bad, true) }
        }
    }
    @Test fun displayOmitsDefaultPort() {
        assertEquals("files.example.com", ServerUrl.display("https://files.example.com".toHttpUrl()))
        assertEquals("10.0.2.2:8080", ServerUrl.display("http://10.0.2.2:8080".toHttpUrl()))
    }
}
