package app.emaki.mobile

import app.emaki.mobile.core.DeviceCookie
import app.emaki.mobile.core.Hello
import app.emaki.mobile.core.HostPort
import app.emaki.mobile.core.Me
import app.emaki.mobile.core.ReconnectResult
import app.emaki.mobile.core.SavedServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 断线处理（ConnectionWatch，docs/mobile.md 3.6）：网页报连不上时原生核实（通 / 不通），「电脑不在线」页面上自动重连的退避、
 * 在后台不探、「重试」和换网络马上试，连上新地址后回到主界面、Cookie 写到新地址上。时间是虚拟的（runTest），不真的等。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionWatchTest {
    private val home = HostPort("192.168.1.5", 5175)
    private val moved = HostPort("192.168.1.23", 5175)
    private val server = SavedServer("srv-1", "书房的电脑", "ab".repeat(32), home, listOf("192.168.1.5"), 5175, "dev-a", "tok-a")
    private val hello = Hello("emaki", 1, "srv-1", "书房的电脑", "0.1.16", "0.1.0", 5175, listOf("192.168.1.23"), true)
    private val me = Me("dev-a", "Pixel", listOf("read"))
    private val offline = ReconnectResult.Offline(listOf(home), null)

    /** 假的重连：按顺序给结果，记下每次是什么时候试的（虚拟时间） */
    private class Fake(val results: ArrayDeque<ReconnectResult>) {
        val at = mutableListOf<Long>()
    }

    private fun TestScope.watch(
        start: Screen,
        alive: Boolean = false,
        results: List<ReconnectResult> = emptyList(),
        aliveGate: CompletableDeferred<Unit>? = null,
    ): Triple<ConnectionWatch, MutableStateFlow<Screen>, Fake> {
        val screen = MutableStateFlow(start)
        val fake = Fake(ArrayDeque(results))
        val w = ConnectionWatch(
            scope = backgroundScope,
            screen = screen,
            alive = { _, _ ->
                aliveGate?.await()
                alive
            },
            reconnect = {
                fake.at += currentTime
                fake.results.removeFirstOrNull() ?: offline
            },
            toScreen = { s, r ->
                when (r) {
                    is ReconnectResult.Online -> Screen.Main(s.copy(lastAddress = r.address), r.address)
                    is ReconnectResult.Removed -> Screen.Removed(s, r.address, r.revoked)
                    is ReconnectResult.Upgrade -> Screen.Upgrade(r.minAppVersion)
                    is ReconnectResult.Offline -> Screen.Offline(s, r.certMismatch)
                }
            },
        )
        return Triple(w, screen, fake)
    }

    @Test
    fun `网页报连不上，核实是通的：什么都不换`() = runTest {
        val main = Screen.Main(server, home)
        val (w, screen) = watch(main, alive = true)
        w.verify(main, "网页报连不上")
        runCurrent()
        assertEquals(main, screen.value)
    }

    @Test
    fun `网页报连不上，核实不通：换到「电脑不在线」`() = runTest {
        val main = Screen.Main(server, home)
        val (w, screen) = watch(main, alive = false)
        w.verify(main, "网页报连不上")
        runCurrent()
        // 隔 1 秒再试一次，还不通才换
        assertEquals(main, screen.value)
        advanceTimeBy(1_001)
        assertEquals(Screen.Offline(server, null), screen.value)
    }

    @Test
    fun `核实第一次不通、隔 1 秒再试通了（换网络的那一下）：不换页面`() = runTest {
        val main = Screen.Main(server, home)
        val answers = ArrayDeque(listOf(false, true))
        val at = mutableListOf<Long>()
        val screen = MutableStateFlow<Screen>(main)
        val w = ConnectionWatch(
            scope = backgroundScope,
            screen = screen,
            alive = { _, _ ->
                at += currentTime
                answers.removeFirst()
            },
            reconnect = { offline },
            toScreen = { s, _ -> Screen.Offline(s, null) },
        )
        w.verify(main, "换了网络")
        advanceTimeBy(5_000)
        assertEquals(main, screen.value)
        assertEquals(listOf(0L, 1_000L), at)
    }

    @Test
    fun `核实的时候页面已经换了（比如被移除了）：不再换`() = runTest {
        val main = Screen.Main(server, home)
        val gate = CompletableDeferred<Unit>()
        val (w, screen) = watch(main, alive = false, aliveGate = gate)
        w.verify(main, "网页报连不上")
        runCurrent()
        val removed = Screen.Removed(server, home, true)
        screen.value = removed
        gate.complete(Unit)
        runCurrent()
        assertEquals(removed, screen.value)
    }

    @Test
    fun `不在线：马上试一次，之后隔 3、5、10、20、30、30 秒`() = runTest {
        val (w, _, fake) = watch(Screen.Offline(server, null))
        w.foreground(true)
        runCurrent()
        advanceTimeBy(3_000 + 5_000 + 10_000 + 20_000 + 30_000 + 30_000 + 1)
        assertEquals(listOf(0L, 3_000L, 8_000L, 18_000L, 38_000L, 68_000L, 98_000L), fake.at)
    }

    @Test
    fun `电脑回来了、换了地址：回到主界面，Cookie 写到新地址上`() = runTest {
        val online = ReconnectResult.Online(moved, hello, me)
        val (w, screen, fake) = watch(Screen.Offline(server, null), results = listOf(offline, offline, online))
        w.foreground(true)
        runCurrent()
        advanceTimeBy(8_001)
        assertEquals(3, fake.at.size)
        val main = screen.value as Screen.Main
        assertEquals(moved, main.address)
        // WebScreen 按 Main 的地址建 WebView、写 Cookie
        val cookies = mutableListOf<String>()
        DeviceCookie.open(main.address, main.server.token, set = { url, _, done -> cookies += url; done() }, load = {})
        assertEquals(listOf("https://192.168.1.23:5175/"), cookies)
        // 连上了就不再试
        advanceTimeBy(120_000)
        assertEquals(3, fake.at.size)
    }

    @Test
    fun `电脑说这台手机被移除了：换到「已被电脑移除」，不再试`() = runTest {
        val (w, screen, fake) = watch(Screen.Offline(server, null), results = listOf(ReconnectResult.Removed(home, hello, true)))
        w.foreground(true)
        runCurrent()
        assertEquals(Screen.Removed(server, home, true), screen.value)
        advanceTimeBy(60_000)
        assertEquals(1, fake.at.size)
    }

    @Test
    fun `在后台不探；回到前台马上试，间隔从头算`() = runTest {
        val (w, _, fake) = watch(Screen.Offline(server, null))
        runCurrent()
        advanceTimeBy(60_000)
        assertTrue("没到前台不该试", fake.at.isEmpty())
        w.foreground(true)
        runCurrent()
        advanceTimeBy(8_001)
        assertEquals(listOf(60_000L, 63_000L, 68_000L), fake.at)
        w.foreground(false)
        runCurrent()
        advanceTimeBy(100_000)
        assertEquals(3, fake.at.size)
        w.foreground(true)
        runCurrent()
        advanceTimeBy(3_001)
        assertEquals(listOf(60_000L, 63_000L, 68_000L, 168_001L, 171_001L), fake.at)
    }

    @Test
    fun `「重试」、换了网络：马上试，间隔从头算`() = runTest {
        val (w, _, fake) = watch(Screen.Offline(server, null))
        w.foreground(true)
        runCurrent()
        advanceTimeBy(18_500) // 试过 0、3、8、18 秒，下一次本来在 38 秒
        w.kick()
        runCurrent()
        assertEquals(listOf(0L, 3_000L, 8_000L, 18_000L, 18_500L), fake.at)
        w.networkChanged()
        runCurrent()
        advanceTimeBy(3_001)
        assertEquals(listOf(0L, 3_000L, 8_000L, 18_000L, 18_500L, 18_500L, 21_500L), fake.at)
    }

    @Test
    fun `试的时候页面上显示正在找；没连上时留在不在线页面，带上证书不对的地址`() = runTest {
        val mismatch = ReconnectResult.Offline(listOf(home), home)
        val gate = CompletableDeferred<Unit>()
        val screen = MutableStateFlow<Screen>(Screen.Offline(server, null))
        val w = ConnectionWatch(
            scope = backgroundScope,
            screen = screen,
            alive = { _, _ -> false },
            reconnect = {
                gate.await()
                mismatch
            },
            toScreen = { s, _ -> Screen.Offline(s, null) },
        )
        w.foreground(true)
        runCurrent()
        assertTrue((screen.value as Screen.Offline).trying)
        gate.complete(Unit)
        runCurrent()
        val s = screen.value as Screen.Offline
        assertFalse(s.trying)
        assertEquals(home, s.certMismatch)
    }

    @Test
    fun `回到前台、换了网络时主界面核实一次`() = runTest {
        val main = Screen.Main(server, home)
        val (w, screen) = watch(main, alive = false)
        w.foreground(true)
        advanceTimeBy(1_001)
        assertEquals(Screen.Offline(server, null), screen.value)

        val (w2, screen2) = watch(main, alive = false)
        w2.networkChanged()
        advanceTimeBy(1_001)
        assertEquals(Screen.Offline(server, null), screen2.value)
    }

    // ---------------------------------------------------------------- 「电脑不在线」页面上在局域网里搜这台电脑

    /** 假的发现源（NsdManager）：emit 一个电脑标识就是搜到一条广播；subscriptionCount 是现在有没有在搜 */
    private class FakeNsd {
        val flow = MutableSharedFlow<String>()
        val searching get() = flow.subscriptionCount.value > 0
    }

    private fun TestScope.watchWithNsd(
        nsd: FakeNsd,
        start: Screen = Screen.Offline(server, null),
        gate: (suspend () -> Unit)? = null,
        results: List<ReconnectResult> = emptyList(),
    ): Triple<ConnectionWatch, MutableStateFlow<Screen>, Fake> {
        val screen = MutableStateFlow(start)
        val fake = Fake(ArrayDeque(results))
        val w = ConnectionWatch(
            scope = backgroundScope,
            screen = screen,
            alive = { _, _ -> false },
            reconnect = {
                fake.at += currentTime
                gate?.invoke()
                fake.results.removeFirstOrNull() ?: offline
            },
            toScreen = { s, r -> if (r is ReconnectResult.Online) Screen.Main(s, r.address) else Screen.Offline(s, null) },
            sightings = { nsd.flow },
            now = { currentTime },
        )
        return Triple(w, screen, fake)
    }

    @Test
    fun `搜到保存的那台电脑：不等间隔，马上完整重连一次（换了地址也接上）`() = runTest {
        val nsd = FakeNsd()
        val (w, screen, fake) = watchWithNsd(nsd, results = listOf(offline, ReconnectResult.Online(moved, hello, me)))
        w.foreground(true)
        runCurrent()
        assertTrue("不在线页面在前台时在搜", nsd.searching)
        advanceTimeBy(2_500) // 第一次试在 0 秒，下一次本来在 3 秒
        nsd.flow.emit("srv-1")
        runCurrent()
        assertEquals(listOf(0L, 2_500L), fake.at)
        assertEquals(moved, (screen.value as Screen.Main).address)
    }

    @Test
    fun `搜到别的电脑：不理`() = runTest {
        val nsd = FakeNsd()
        val (w, _, fake) = watchWithNsd(nsd)
        w.foreground(true)
        runCurrent()
        advanceTimeBy(2_500)
        nsd.flow.emit("srv-other")
        runCurrent()
        assertEquals(listOf(0L), fake.at)
        advanceTimeBy(501)
        assertEquals(listOf(0L, 3_000L), fake.at)
    }

    @Test
    fun `同一台电脑的广播连着来好几条、正在重连时又来：只重连一次`() = runTest {
        val nsd = FakeNsd()
        var hold: CompletableDeferred<Unit>? = null
        val (w, _, fake) = watchWithNsd(nsd, gate = { hold?.await() })
        w.foreground(true)
        runCurrent()
        advanceTimeBy(2_500)
        // 每块网卡一条，挤在一起到
        hold = CompletableDeferred()
        repeat(3) { nsd.flow.emit("srv-1") }
        runCurrent()
        assertEquals(listOf(0L, 2_500L), fake.at)
        // 正在重连（还没回来）时又来几条
        repeat(3) { nsd.flow.emit("srv-1") }
        runCurrent()
        hold!!.complete(Unit)
        hold = null
        runCurrent()
        // 刚试完 2 秒内来的也不算
        advanceTimeBy(1_000)
        nsd.flow.emit("srv-1")
        runCurrent()
        assertEquals(listOf(0L, 2_500L), fake.at)
        // 之后照常按间隔（搜到时间隔从头算：3 秒）
        advanceTimeBy(2_001)
        assertEquals(listOf(0L, 2_500L, 5_500L), fake.at)
        // 过了 2 秒再来一条（30 秒一次的刷新）：再重连一次
        advanceTimeBy(2_500)
        nsd.flow.emit("srv-1")
        runCurrent()
        assertEquals(listOf(0L, 2_500L, 5_500L, 8_001L), fake.at)
    }

    @Test
    fun `离开不在线页面、App 到后台：停止搜索`() = runTest {
        val nsd = FakeNsd()
        val (w, screen, _) = watchWithNsd(nsd)
        runCurrent()
        assertFalse("没到前台不搜", nsd.searching)
        w.foreground(true)
        runCurrent()
        assertTrue(nsd.searching)
        w.foreground(false)
        runCurrent()
        assertFalse("到后台停止搜索", nsd.searching)
        w.foreground(true)
        runCurrent()
        assertTrue(nsd.searching)
        screen.value = Screen.Reconnecting("书房的电脑") // 比如点了「换地址」
        runCurrent()
        assertFalse("离开页面停止搜索", nsd.searching)
    }
}
