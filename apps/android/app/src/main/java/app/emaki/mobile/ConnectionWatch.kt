package app.emaki.mobile

import app.emaki.mobile.core.Backoff
import app.emaki.mobile.core.HostPort
import app.emaki.mobile.core.ReconnectResult
import app.emaki.mobile.core.SavedServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 断线处理（docs/mobile.md 3.6）：主界面上核实连接，「电脑不在线」页面上自动重连。页面状态是 AppModel 的 screen，这里只管什么时候换。
 *
 * - verify(main)：网页报连不上（window.EmakiApp.connectionLost）、App 回到前台、手机换了网络时调。对现在的地址发 hello
 *   （LinkCheck：只认保存的证书，2 秒超时）：通的话什么都不做（网页误报，或者只是短暂掉线），只记日志；
 *   不通的话隔 1 秒再试一次（换网络的那一下，旧网络上的连接会马上失败），还不通才换到「电脑不在线」；
 * - 页面是「电脑不在线」、App 在前台时一直自动重连：马上试一次，之后隔 3、5、10、20 秒，再往后每 30 秒试一次。
 *   每次都是完整的重连（Reconnector：NSD 按电脑标识找、上次的地址、hello 给过的其他地址），所以电脑换了地址也接得上；
 *   找到了就换到主界面（toScreen：保存新地址），WebView 按新地址重建、重新写 Cookie；
 * - 在后台不探（省电）：foreground(false) 停掉自动重连，回到前台时马上再试；
 * - kick()：点了「重试」、换了网络：不等了，马上试，间隔从头算；
 * - 自动重连的同时在局域网里搜这台电脑（sightings：NsdManager 搜 `_emaki._tcp`，给出每条广播的电脑标识）：
 *   看到保存的那台（不管地址变没变）就马上做一次完整的重连，不等间隔。同一台电脑的广播会连着来好几条（每块网卡一条，还会刷新），
 *   正在重连、或者刚试完 2 秒内来的不再触发。离开这个页面、App 到后台时停止搜索。
 */
class ConnectionWatch(
    private val scope: CoroutineScope,
    private val screen: MutableStateFlow<Screen>,
    private val alive: suspend (SavedServer, HostPort) -> Boolean,
    private val reconnect: suspend (SavedServer) -> ReconnectResult,
    private val toScreen: (SavedServer, ReconnectResult) -> Screen,
    private val steps: List<Long> = Backoff.STEPS,
    private val recheckMs: Long = RECHECK_MS,
    private val sightings: () -> Flow<String> = { emptyFlow() },
    private val now: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
) {
    private val foreground = MutableStateFlow(false)
    private val kicks = Channel<Unit>(Channel.CONFLATED)
    private var checking: Job? = null

    init {
        scope.launch {
            // 只看「是不是在前台的不在线页面、是哪台电脑」：页面上的提示变了（证书提示、正在试）不重新开始
            combine(screen, foreground) { s, fg -> if (fg && s is Screen.Offline) s.server else null }
                .distinctUntilChanged()
                .collectLatest { server -> if (server != null) keepTrying(server) }
        }
    }

    /** Activity 的 onResume / onPause。回到前台时：主界面核实一次；不在线页面马上再试（上面的 combine） */
    fun foreground(on: Boolean) {
        foreground.value = on
        if (on) (screen.value as? Screen.Main)?.let { verify(it, "回到前台") }
    }

    /** 手机换了网络（离开 Wi-Fi、换到移动数据……）：主界面核实一次，不在线页面马上再试 */
    fun networkChanged() {
        when (val s = screen.value) {
            is Screen.Main -> verify(s, "换了网络")
            is Screen.Offline -> kick()
            else -> Unit
        }
    }

    /** 不等了，马上再试（「电脑不在线」页面上的「重试」） */
    fun kick() {
        kicks.trySend(Unit)
    }

    /** why：谁报的（记日志） */
    fun verify(main: Screen.Main, why: String) {
        if (screen.value != main || checking?.isActive == true) return
        checking = scope.launch {
            val t0 = System.currentTimeMillis()
            var ok = alive(main.server, main.address)
            if (!ok && screen.value == main) {
                delay(recheckMs)
                if (screen.value == main) ok = alive(main.server, main.address)
            }
            if (screen.value != main) return@launch
            val ms = System.currentTimeMillis() - t0
            if (ok) {
                log("$why：核实过，${main.address} 还连着（$ms ms），不换页面")
            } else {
                log("$why：${main.address} 连不上（隔 1 秒再试也不通，共 $ms ms），换到「电脑不在线」，开始自动重连")
                screen.value = Screen.Offline(main.server, null)
            }
        }
    }

    private suspend fun keepTrying(server: SavedServer) = coroutineScope {
        val backoff = Backoff(steps)
        // 之前（在主界面时）攒下的不算
        kicks.tryReceive()
        // 搜到这台电脑时：正在试、已经叫过一次还没开始试、刚试完不久，都不再叫（同一台电脑的广播会连着来好几条）
        var attempting = false
        var sightingPending = false
        var lastEnded = Long.MIN_VALUE / 2
        val search = launch {
            sightings().collect { id ->
                if (id != server.serverId || attempting || sightingPending || now() - lastEnded < SIGHTING_QUIET_MS) return@collect
                log("局域网里搜到了「${server.name}」，马上重连")
                sightingPending = true
                kicks.trySend(Unit)
            }
        }
        try {
            while (true) {
                attempting = true
                sightingPending = false
                setTrying(true)
                val r = try {
                    reconnect(server)
                } finally {
                    attempting = false
                    lastEnded = now()
                }
                val s = screen.value as? Screen.Offline ?: return@coroutineScope
                if (r !is ReconnectResult.Offline) {
                    log("自动重连：连上了 ${(r as? ReconnectResult.Online)?.address ?: r.javaClass.simpleName}")
                    screen.value = toScreen(server, r)
                    return@coroutineScope
                }
                screen.value = s.copy(certMismatch = r.certMismatch, trying = false)
                val wait = backoff.next()
                val kicked = withTimeoutOrNull(wait) { kicks.receive() } != null
                if (kicked) backoff.reset()
            }
        } finally {
            search.cancel()
        }
    }

    companion object {
        /** 核实不通时隔多久再试一次 */
        const val RECHECK_MS = 1_000L

        /** 刚试完这么久之内搜到的广播不再触发重连（同一批广播里后到的几条） */
        const val SIGHTING_QUIET_MS = 2_000L
    }

    private fun setTrying(on: Boolean) {
        val s = screen.value as? Screen.Offline ?: return
        if (s.trying != on) screen.value = s.copy(trying = on)
    }
}
