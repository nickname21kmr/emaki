package app.emaki.mobile.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ProtocolTest {
    @Test
    fun `hello`() {
        val h = Json.hello(
            """{"app":"emaki","protocol":1,"serverId":"abc","name":"zc-desktop","version":"0.1.16","minAppVersion":"0.1.0",
               "port":5195,"addresses":["192.168.0.100","100.64.1.2"],"pairing":true,"fingerprint":"ff"}""",
        )
        assertEquals(Hello("emaki", 1, "abc", "zc-desktop", "0.1.16", "0.1.0", 5195, listOf("192.168.0.100", "100.64.1.2"), true), h)
        // 少了必须的字段
        try {
            Json.hello("""{"app":"emaki"}""")
            fail()
        } catch (_: ProtocolException) {
        }
        try {
            Json.hello("<html>")
            fail()
        } catch (_: ProtocolException) {
        }
    }

    @Test
    fun `pair 和 status`() {
        assertEquals(PairStarted("k1", "00".repeat(32), "2026-11-18T10:00:00.000Z"),
            Json.pairStarted("""{"id":"k1","nonce":"${"00".repeat(32)}","expiresAt":"2026-11-18T10:00:00.000Z"}"""))
        assertEquals(PairStatus.Pending, Json.pairStatus("""{"status":"pending"}"""))
        assertEquals(PairStatus.Approved("d1", "tok"), Json.pairStatus("""{"status":"approved","deviceId":"d1","token":"tok"}"""))
        assertEquals(PairStatus.Rejected, Json.pairStatus("""{"status":"rejected"}"""))
        assertEquals(PairStatus.Expired, Json.pairStatus("""{"status":"expired"}"""))
        try {
            Json.pairStatus("""{"status":"weird"}""")
            fail()
        } catch (_: ProtocolException) {
        }
        try {
            Json.pairStatus("""{"status":"approved"}""")
            fail("批准了却没给凭证")
        } catch (_: ProtocolException) {
        }
    }

    @Test
    fun `me 和错误`() {
        assertEquals(Me("d1", "Pixel 7", listOf("read", "curate")), Json.me("""{"deviceId":"d1","name":"Pixel 7","scopes":["read","curate"]}"""))
        val revoked = Json.error(401, """{"ok":false,"error":"这台设备已经被电脑移除，请重新请求连接","code":"device_revoked"}""")
        assertTrue(revoked.revoked)
        assertTrue(revoked.unauthorized)
        assertEquals("这台设备已经被电脑移除，请重新请求连接", revoked.message)
        val unauthorized = Json.error(401, """{"ok":false,"error":"需要先在电脑上批准这台设备","code":"unauthorized"}""")
        assertFalse(unauthorized.revoked)
        assertTrue(unauthorized.unauthorized)
        val weird = Json.error(502, "Bad Gateway")
        assertNull(weird.code)
        assertEquals("电脑返回了错误（502）", weird.message)
        assertFalse(Json.error(403, """{"code":"forbidden","error":"x"}""").unauthorized)
    }

    @Test
    fun `请求体`() {
        val start = JSONObject(Json.pairStartBody("Pixel 7", "Google Pixel 7 · Android 14", commit = "ab"))
        assertEquals("Pixel 7", start.getString("name"))
        assertEquals("Google Pixel 7 · Android 14", start.getString("model"))
        assertEquals("ab", start.getString("commit"))
        assertFalse(start.has("ticket"))
        val ticket = JSONObject(Json.pairStartBody("Pixel 7", null, ticket = "t"))
        assertEquals("t", ticket.getString("ticket"))
        assertFalse(ticket.has("model"))
        assertFalse(ticket.has("commit"))
        assertEquals("cd", JSONObject(Json.revealBody("cd")).getString("nonce"))
    }

    @Test
    fun `版本比较`() {
        assertTrue(Versions.tooOld("0.1.0", "0.2.0"))
        assertTrue(Versions.tooOld("0.9.0", "0.10.0"))
        assertTrue(Versions.tooOld("0.1", "0.1.1"))
        assertFalse(Versions.tooOld("0.1.0", "0.1.0"))
        assertFalse(Versions.tooOld("0.1.0", "0.1"))
        assertFalse(Versions.tooOld("0.2.0", "0.1.9"))
        assertFalse(Versions.tooOld("0.1.0-debug", "0.1.0"))
        assertFalse(Versions.tooOld("0.1.0", ""))
    }

    @Test
    fun `hello 的检查：不是 Emaki、要更新 App、电脑太旧`() {
        val h = Hello("emaki", 1, "s", "n", "0.1.16", "0.1.0", 5175, emptyList(), true)
        Pairing.check(h, "0.1.0")
        try {
            Pairing.check(h.copy(app = "other"), "0.1.0")
            fail()
        } catch (_: NotEmakiException) {
        }
        try {
            Pairing.check(h.copy(minAppVersion = "0.2.0"), "0.1.0")
            fail()
        } catch (e: UpgradeRequiredException) {
            assertEquals("0.2.0", e.minAppVersion)
        }
        try {
            Pairing.check(h.copy(protocol = 2), "0.1.0")
            fail("协议比 App 新：要更新 App")
        } catch (_: UpgradeRequiredException) {
        }
        try {
            Pairing.check(h.copy(protocol = 0), "0.1.0")
            fail()
        } catch (_: ProtocolException) {
        }
    }
}
