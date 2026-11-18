package app.emaki.mobile.core

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket

/** 网页报连不上时原生的核实（LinkCheck）、自动重连的间隔（Backoff）、打开网页前写 Cookie（DeviceCookie） */
class LivenessTest {
    private val started = mutableListOf<FakeComputer>()
    private fun computer(id: String = "srv-1"): FakeComputer = FakeComputer(serverId = id).start().also { started += it }

    @After
    fun stop() = started.forEach { it.stop() }

    private fun deadAddress(): HostPort {
        val s = ServerSocket(0)
        val port = s.localPort
        s.close()
        return HostPort("127.0.0.1", port)
    }

    private fun saved(c: FakeComputer, fingerprint: ByteArray = c.fingerprint) =
        SavedServer(c.serverId, c.name, Hex.encode(fingerprint), c.address, emptyList(), c.address.port, "dev-a", "tok-a")

    private val check = LinkCheck(timeoutMs = 1_000)

    @Test
    fun `通：hello 回来了、电脑标识对得上`() = runBlocking {
        val c = computer()
        assertTrue(check.alive(saved(c), c.address))
    }

    @Test
    fun `不通：地址上没有东西（电脑上的服务停了）`() = runBlocking {
        val c = FakeComputer()
        val s = saved(c).copy(lastAddress = deadAddress())
        assertFalse(check.alive(s, s.lastAddress))
    }

    @Test
    fun `不通：超时（手机离开了家里的网络，包发出去没有回音）`() = runBlocking {
        val c = computer()
        c.helloDelayMs = 2_500
        val t0 = System.currentTimeMillis()
        assertFalse(check.alive(saved(c), c.address))
        val ms = System.currentTimeMillis() - t0
        assertTrue("应该在超时（1 秒）后不久就放弃，用了 $ms ms", ms in 900..3_000)
    }

    @Test
    fun `不通：证书不是保存的那张（一个请求都不发）`() = runBlocking {
        val impostor = computer()
        val real = FakeComputer()
        assertFalse(check.alive(saved(impostor, fingerprint = real.fingerprint), impostor.address))
        assertEquals(0, impostor.server.requestCount)
    }

    @Test
    fun `不通：证书对、但不是这台电脑（serverId 不同）`() = runBlocking {
        val other = computer(id = "srv-other")
        assertFalse(check.alive(saved(other).copy(serverId = "srv-1"), other.address))
    }

    @Test
    fun `自动重连的间隔：3、5、10、20 秒，之后一直 30 秒；从头算`() {
        val b = Backoff()
        assertEquals(listOf(3_000L, 5_000L, 10_000L, 20_000L, 30_000L, 30_000L, 30_000L), List(7) { b.next() })
        b.reset()
        assertEquals(3_000L, b.next())
    }

    @Test
    fun `打开网页前：先给这个地址写 Cookie，写好了才加载`() {
        val calls = mutableListOf<String>()
        DeviceCookie.open(
            HostPort("192.168.1.9", 5175),
            "tok-a",
            set = { url, value, done ->
                calls += "set $url $value"
                done()
            },
            load = { calls += "load $it" },
        )
        assertEquals(
            listOf(
                "set https://192.168.1.9:5175/ emaki_device=tok-a; Secure; HttpOnly; SameSite=Strict; Path=/",
                "load https://192.168.1.9:5175/",
            ),
            calls,
        )
    }
}
