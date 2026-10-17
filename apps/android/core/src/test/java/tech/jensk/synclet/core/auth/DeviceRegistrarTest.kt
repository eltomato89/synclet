package tech.jensk.synclet.core.auth

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import tech.jensk.synclet.core.api.sha256Hex
import tech.jensk.synclet.core.testing.json

class DeviceRegistrarTest {
    private val server = MockWebServer()
    @Before fun setUp() = server.start()
    @After fun tearDown() { runCatching { server.shutdown() } }

    @Test fun registersAsAndroidWithAccessToken() = runBlocking {
        server.json(
            """{"device":{"id":"d1","name":"Pixel 9","platform":"android","appVersion":"0.1.5","createdAt":"2026-10-16T08:00:00.000Z","lastSeenAt":null},""" +
                """"token":"syd_${"a".repeat(43)}","account":{"userId":"u1","email":null,"displayName":"Jens","organizationId":"srv:u1","organizationName":"Synclet",""" +
                """"slug":"jens","canWrite":true,"spaces":[],"areas":{"personal":true,"shared":false,"customers":false,"projects":false},""" +
                """"quotaBytes":0,"usedBytes":0,"maxUploadBytes":0,"cursor":"0"}}""",
            201,
        )
        val installation = DeviceRegistrar.installationId("abc")
        val registration = DeviceRegistrar(OkHttpClient()).register(server.url("/"), "jwt", "Pixel 9", installation, "0.1.5")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sync/v1/devices", request.path)
        assertEquals("Bearer jwt", request.getHeader("Authorization"))
        val body = request.body.readUtf8()
        assertTrue(body, body.contains("\"platform\":\"android\""))
        assertTrue(body, body.contains("\"name\":\"Pixel 9\""))
        assertTrue(body, body.contains("\"appVersion\":\"0.1.5\""))
        assertTrue(body, Regex("\"installationId\":\"[0-9a-f]{64}\"").containsMatchIn(body))
        assertEquals("d1", registration.device.id)
    }
    @Test fun truncatesWithoutSplittingSurrogates() {
        assertEquals(99, DeviceRegistrar.truncateUtf16("a".repeat(99) + "😀", 100).length)
        assertEquals("abc", DeviceRegistrar.truncateUtf16("abc", 100))
    }
    @Test fun installationIdIsSha256OfAndroidId() {
        assertEquals(sha256Hex("abc"), DeviceRegistrar.installationId("abc"))
        assertNull(DeviceRegistrar.installationId(null))
        assertNull(DeviceRegistrar.installationId(""))
    }
}
