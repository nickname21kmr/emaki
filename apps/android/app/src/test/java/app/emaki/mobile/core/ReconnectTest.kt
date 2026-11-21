package app.emaki.mobile.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket

class ReconnectTest {
    private val started = mutableListOf<FakeComputer>()
    private fun computer(id: String = "srv-1", cert: okhttp3.tls.HeldCertificate? = null): FakeComputer =
        (if (cert != null) FakeComputer(serverId = id, cert = cert) else FakeComputer(serverId = id)).start().also { started += it }

    @After
    fun stop() = started.forEach { it.stop() }

    /** 一个连不上的地址（端口刚刚还开着，现在关了） */
    private fun deadAddress(): HostPort {
        val s = ServerSocket(0)
        val port = s.localPort
        s.close()
        return HostPort("127.0.0.1", port)
    }

    private fun saved(c: FakeComputer, last: HostPort, others: List<String> = emptyList(), port: Int = c.address.port, token: String = "tok-a") =
        SavedServer(c.serverId, c.name, Hex.encode(c.fingerprint), last, others, port, "dev-a", token).also { c.tokens[token] = "dev-a" }

    private val reconnector = Reconnector("0.1.0", nsdTimeoutMs = 500, othersDelayMs = 300)

    @Test
    fun `上次的地址还能连：直接连上`() = runBlocking {
        val c = computer()
        val r = reconnector.run(saved(c, c.address)) { null }
        assertTrue(r is ReconnectResult.Online)
        assertEquals(c.address, (r as ReconnectResult.Online).address)
        assertEquals("dev-a", r.me.deviceId)
    }

    @Test
    fun `上次的地址连不上：用 NSD 按标识找到的新地址`() = runBlocking {
        val c = computer()
        val r = reconnector.run(saved(c, deadAddress())) { c.address }
        assertEquals(c.address, (r as ReconnectResult.Online).address)
    }

    @Test
    fun `上次的地址和 NSD 都不行：试 hello 给过的其他地址（端口用 hello 的）`() = runBlocking {
        val c = computer()
        val s = saved(c, deadAddress(), others = listOf("127.0.0.2", c.server.hostName), port = c.server.port)
        val r = reconnector.run(s) {
            delay(100)
            null
        }
        assertEquals(HostPort(c.server.hostName, c.server.port), (r as ReconnectResult.Online).address)
    }

    @Test
    fun `证书对不上的不用：记下来，最后是不在线`() = runBlocking {
        val impostor = computer()
        val real = FakeComputer()
        // 保存的是 real 的指纹，地址上却是 impostor（同一个 serverId）
        val s = SavedServer(real.serverId, real.name, Hex.encode(real.fingerprint), impostor.address, emptyList(), impostor.address.port, "dev-a", "tok-a")
        val r = reconnector.run(s) { null }
        assertTrue(r is ReconnectResult.Offline)
        assertEquals(impostor.address, (r as ReconnectResult.Offline).certMismatch)
        assertEquals("证书对不上时一个请求都不该发", 0, impostor.server.requestCount)
    }

    @Test
    fun `证书对上了但不是这台电脑（serverId 不同）：不用`() = runBlocking {
        val other = computer(id = "srv-other")
        val s = saved(other, other.address).copy(serverId = "srv-1")
        val r = reconnector.run(s) { null }
        assertTrue(r is ReconnectResult.Offline)
        assertNull((r as ReconnectResult.Offline).certMismatch)
    }

    @Test
    fun `被电脑移除了`() = runBlocking {
        val c = computer()
        val s = saved(c, c.address)
        c.revoked += "dev-a"
        val r = reconnector.run(s) { null }
        assertTrue(r is ReconnectResult.Removed)
        assertTrue((r as ReconnectResult.Removed).revoked)
    }

    @Test
    fun `电脑不认识这个凭证（重装过）：也是被移除，但不是 revoked`() = runBlocking {
        val c = computer()
        val s = saved(c, c.address).copy(token = "unknown")
        val r = reconnector.run(s) { null }
        assertEquals(false, (r as ReconnectResult.Removed).revoked)
    }

    @Test
    fun `电脑要求更新 App`() = runBlocking {
        val c = computer()
        c.minAppVersion = "9.0.0"
        val r = reconnector.run(saved(c, c.address)) { null }
        assertEquals(ReconnectResult.Upgrade("9.0.0"), r)
    }

    @Test
    fun `哪个都连不上：不在线，列出试过的地址（去重）`() = runBlocking {
        val dead = deadAddress()
        val c = FakeComputer()
        val s = SavedServer(c.serverId, c.name, Hex.encode(c.fingerprint), dead, listOf(dead.host, "127.0.0.3"), dead.port, "d", "t")
        val r = reconnector.run(s) { dead }
        assertTrue(r is ReconnectResult.Offline)
        assertEquals(listOf(dead, HostPort("127.0.0.3", dead.port)), (r as ReconnectResult.Offline).tried)
    }

    @Test
    fun `NSD 一直找不到也不会一直等`() = runBlocking {
        val dead = deadAddress()
        val c = FakeComputer()
        val s = SavedServer(c.serverId, c.name, Hex.encode(c.fingerprint), dead, emptyList(), dead.port, "d", "t")
        val t0 = System.currentTimeMillis()
        val r = reconnector.run(s) {
            delay(60_000)
            null
        }
        assertTrue(r is ReconnectResult.Offline)
        assertTrue("应该在 NSD 超时（0.5 秒）后不久结束", System.currentTimeMillis() - t0 < 5_000)
    }
}
