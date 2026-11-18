package app.emaki.mobile.core

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PairingTest {
    private val computer = FakeComputer().start()
    private val pairing = Pairing("0.1.0")

    @After
    fun stop() = computer.stop()

    @Test
    fun `请求连接：校验码和电脑上算的一样，批准后拿到凭证`() = runBlocking {
        val conn = pairing.connect(computer.address)
        assertArrayEquals(computer.fingerprint, conn.fingerprint)
        assertEquals("srv-1", conn.hello.serverId)

        val attempt = pairing.request(conn, "Pixel 7", "Google Pixel 7 · Android 14")
        val req = computer.requests[attempt.id]!!
        assertEquals("电脑上的校验码", req.code, attempt.code)
        assertEquals(6, attempt.code.length)

        // 先 pending 一次，再批准
        computer.pendingPolls = 1
        val status = pairing.awaitDecision(conn, attempt)
        assertTrue(status is PairStatus.Approved)
        status as PairStatus.Approved
        assertEquals("dev-${attempt.id}", status.deviceId)
        assertTrue(computer.tokens.containsKey(status.token))
    }

    @Test
    fun `请求顺序：hello → pair（只带 commit）→ reveal → 长轮询`() = runBlocking {
        val conn = pairing.connect(computer.address)
        val nonceA = ByteArray(32) { 7 }
        val attempt = pairing.request(conn, "Pixel 7", "m", nonceA)
        computer.pendingPolls = 0
        pairing.awaitDecision(conn, attempt)
        val reqs = List(computer.server.requestCount) { computer.server.takeRequest() }
        assertEquals(listOf("GET /api/v1/hello", "POST /api/v1/pair", "POST /api/v1/pair/${attempt.id}/reveal", "GET /api/v1/pair/${attempt.id}?wait=25"),
            reqs.map { "${it.method} ${it.path}" })
        val start = org.json.JSONObject(reqs[1].body.readUtf8())
        assertEquals(PairCrypto.commit(nonceA), start.getString("commit"))
        assertTrue("pair 时不能带出 nonceA", !start.toString().contains(Hex.encode(nonceA)))
        assertEquals(Hex.encode(nonceA), org.json.JSONObject(reqs[2].body.readUtf8()).getString("nonce"))
    }

    @Test
    fun `拒绝、过期`() = runBlocking {
        val conn = pairing.connect(computer.address)
        computer.pendingPolls = 0
        computer.decide = { "rejected" }
        assertEquals(PairStatus.Rejected, pairing.awaitDecision(conn, pairing.request(conn, "a", null)))
        computer.decide = { "expired" }
        assertEquals(PairStatus.Expired, pairing.awaitDecision(conn, pairing.request(conn, "a", null)))
    }

    @Test
    fun `扫码：二维码里的指纹对上才连，带口令直接批准`() = runBlocking {
        computer.tickets += "t1"
        val conn = pairing.connect(computer.address, computer.fingerprint)
        val approved = conn.api.startPairWithTicket("Pixel 7", null, "t1")
        assertTrue(computer.tokens.containsKey(approved.token))
        // 口令只能用一次
        try {
            conn.api.startPairWithTicket("Pixel 7", null, "t1")
            fail()
        } catch (e: ApiException) {
            assertEquals(403, e.status)
        }
        // 二维码里的指纹和电脑的对不上
        try {
            pairing.connect(computer.address, ByteArray(32))
            fail()
        } catch (e: Exception) {
            assertTrue(e.fingerprintMismatch() != null)
        }
    }

    @Test
    fun `电脑要求更新 App`() = runBlocking {
        computer.minAppVersion = "0.2.0"
        try {
            pairing.connect(computer.address)
            fail()
        } catch (e: UpgradeRequiredException) {
            assertEquals("0.2.0", e.minAppVersion)
        }
    }
}
