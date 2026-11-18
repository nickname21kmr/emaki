package app.emaki.mobile

import android.app.Application
import android.util.Log
import android.webkit.CookieManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.emaki.mobile.core.ApiException
import app.emaki.mobile.core.Connected
import app.emaki.mobile.core.EmakiApi
import app.emaki.mobile.core.Hello
import app.emaki.mobile.core.Hex
import app.emaki.mobile.core.HostPort
import app.emaki.mobile.core.LinkCheck
import app.emaki.mobile.core.NotEmakiException
import app.emaki.mobile.core.PairAttempt
import app.emaki.mobile.core.PairStatus
import app.emaki.mobile.core.PairTicket
import app.emaki.mobile.core.Pairing
import app.emaki.mobile.core.PairingClosedException
import app.emaki.mobile.core.ProtocolException
import app.emaki.mobile.core.ReconnectResult
import app.emaki.mobile.core.Reconnector
import app.emaki.mobile.core.SavedServer
import app.emaki.mobile.core.UpgradeRequiredException
import app.emaki.mobile.core.fingerprintMismatch
import app.emaki.mobile.platform.DeviceInfo
import app.emaki.mobile.platform.Discovery
import app.emaki.mobile.platform.serverStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

/** 现在显示哪一页 */
sealed interface Screen {
    /** 正在连接配对过的电脑（每次打开、重试） */
    data class Reconnecting(val name: String) : Screen

    /** 还没配对过：找电脑 */
    data object Find : Screen

    /** 正在连一个地址（握手、hello） */
    data class Connecting(val address: HostPort, val label: String) : Screen

    /** 连上了一台电脑，确认设备名称后请求连接 */
    data class Request(val conn: Connected) : Screen

    /** 等电脑批准：显示校验码 */
    data class Waiting(val conn: Connected, val attempt: PairAttempt) : Screen

    /** 主界面：电脑提供的网页。generation 变了就重建 WebView（重新写 Cookie、重新加载） */
    data class Main(val server: SavedServer, val address: HostPort, val generation: Int = 0) : Screen

    /** 哪个地址都没连上。在前台时一直自动重连（ConnectionWatch），trying 是正在试 */
    data class Offline(val server: SavedServer, val certMismatch: HostPort?, val note: String? = null, val trying: Boolean = false) : Screen

    /** 电脑不认这台手机了：revoked 是在电脑上被移除了，否则是电脑不认识这个凭证 */
    data class Removed(val server: SavedServer, val address: HostPort, val revoked: Boolean) : Screen

    /** 电脑上的 Emaki 要求更新 App */
    data class Upgrade(val minAppVersion: String) : Screen

    /** 证书不对：可能有人冒充这台电脑 */
    data class CertWrong(val server: SavedServer?, val address: HostPort) : Screen

    /** 请求没成：被拒绝、过期、出错。back 是「重试」回到的页面 */
    data class Failed(val title: String, val message: String, val retry: (() -> Unit)?) : Screen
}

/**
 * App 的状态和流程（docs/mobile.md 第 3 节）：找电脑 → 请求连接 → 等批准 → 保存 → 主界面；之后每次打开无感重连。
 * 协议的细节在 core/（Pairing、Reconnector、EmakiApi），这里只管页面之间怎么走。
 */
class AppModel(app: Application) : AndroidViewModel(app) {
    private val store = serverStore(app)
    val discovery = Discovery(app)
    private val pairing = Pairing(BuildConfig.VERSION_NAME)
    private val reconnector = Reconnector(BuildConfig.VERSION_NAME)

    private val _screen = MutableStateFlow<Screen>(Screen.Find)
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    private val _deviceName = MutableStateFlow(store.deviceName() ?: DeviceInfo.defaultName(app))
    val deviceName: StateFlow<String> = _deviceName.asStateFlow()

    /** 断线处理：主界面上核实连接，「电脑不在线」页面上自动重连（docs/mobile.md 3.6） */
    private val watch = ConnectionWatch(
        scope = viewModelScope,
        screen = _screen,
        alive = LinkCheck()::alive,
        reconnect = { saved -> reconnector.run(saved) { discovery.find(saved.serverId) } },
        toScreen = ::toScreen,
        log = { Log.i(TAG, it) },
    )

    /** 现在在跑的流程（换页时取消：比如等批准时点「取消」） */
    private var job: Job? = null

    init {
        val saved = store.load()
        if (saved != null) reconnect(saved) else _screen.value = Screen.Find
    }

    val savedServer: SavedServer? get() = store.load()

    private fun flow(block: suspend () -> Unit) {
        job?.cancel()
        job = viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "流程出错", e)
                _screen.value = Screen.Failed("出了点问题", describe(e), null)
            }
        }
    }

    fun setDeviceName(name: String) {
        store.setDeviceName(name)
        _deviceName.value = store.deviceName() ?: DeviceInfo.defaultName(getApplication())
    }

    // ---------------------------------------------------------------- 之后每次打开

    /** 无感重连（docs/mobile.md 2.4）：NSD 按 id 找 → 上次的地址 → hello 给过的其他地址 */
    fun reconnect() {
        val saved = store.load()
        if (saved != null) reconnect(saved) else goFind()
    }

    private fun reconnect(saved: SavedServer) {
        _screen.value = Screen.Reconnecting(saved.name)
        flow {
            val t0 = System.currentTimeMillis()
            val result = reconnector.run(saved) { discovery.find(saved.serverId) }
            Log.i(TAG, "重连用了 ${System.currentTimeMillis() - t0} ms：${result.javaClass.simpleName}")
            applyReconnect(saved, result)
        }
    }

    private fun applyReconnect(saved: SavedServer, result: ReconnectResult) {
        _screen.value = toScreen(saved, result)
    }

    /** 重连的结果换到哪一页；连上了的话记下这次的地址（可能是新地址）和 hello 给的地址 */
    private fun toScreen(saved: SavedServer, result: ReconnectResult): Screen = when (result) {
        is ReconnectResult.Online -> {
            val s = store.connected(result.address, result.hello) ?: saved
            Screen.Main(s, result.address)
        }
        is ReconnectResult.Removed -> Screen.Removed(store.connected(result.address, result.hello) ?: saved, result.address, result.revoked)
        is ReconnectResult.Upgrade -> Screen.Upgrade(result.minAppVersion)
        is ReconnectResult.Offline -> Screen.Offline(saved, result.certMismatch)
    }

    /** 「电脑不在线」页面上的「重试」：自动重连不等了，马上试 */
    fun retryNow() = watch.kick()

    /** Activity 的 onResume / onPause：在后台不探 */
    fun foreground(on: Boolean) = watch.foreground(on)

    /** 手机换了网络（ConnectivityManager 的默认网络变了） */
    fun networkChanged() = watch.networkChanged()

    /** 「换地址」：用保存的凭证试一个手动输入的地址（还是只认这台电脑的证书和标识） */
    fun tryAddress(address: HostPort) {
        val saved = store.load() ?: return goFind()
        _screen.value = Screen.Reconnecting(saved.name)
        flow {
            val r = reconnector.tryAddress(saved, address)
            if (r == null) {
                _screen.value = Screen.Offline(saved, null, "$address 上没有找到「${saved.name}」")
            } else {
                applyReconnect(saved, r)
            }
        }
    }

    fun forget() {
        job?.cancel()
        store.clear()
        CookieManager.getInstance().removeAllCookies(null)
        goFind()
    }

    fun goFind() {
        job?.cancel()
        _screen.value = Screen.Find
    }

    // ---------------------------------------------------------------- 请求连接

    /** 连一个地址（列表里点的、手动输入的、被移除后重新请求）。expected：只认这个指纹（重新请求时是保存的指纹） */
    fun connect(address: HostPort, label: String = address.toString(), expected: ByteArray? = null) {
        _screen.value = Screen.Connecting(address, label)
        flow {
            try {
                _screen.value = Screen.Request(pairing.connect(address, expected))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _screen.value = failure(e, address) { connect(address, label, expected) }
            }
        }
    }

    /** 被移除后重新请求：还是这台电脑、还是这张证书 */
    fun requestAgain(server: SavedServer, address: HostPort) = connect(address, server.name, server.fingerprintBytes)

    fun request(conn: Connected) {
        val name = _deviceName.value
        flow {
            val attempt = try {
                pairing.request(conn, name, DeviceInfo.model)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _screen.value = failure(e, conn.address) { _screen.value = Screen.Request(conn) }
                return@flow
            }
            _screen.value = Screen.Waiting(conn, attempt)
            val status = try {
                pairing.awaitDecision(conn, attempt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _screen.value = failure(e, conn.address) { _screen.value = Screen.Request(conn) }
                return@flow
            }
            when (status) {
                is PairStatus.Approved -> paired(conn.hello, conn.address, conn.fingerprint, status)
                PairStatus.Rejected -> _screen.value =
                    Screen.Failed("电脑上拒绝了", "电脑上拒绝了这个请求。要连的话重新请求，再到电脑上点「批准」。") {
                        _screen.value = Screen.Request(conn)
                    }
                PairStatus.Expired -> _screen.value =
                    Screen.Failed("请求过期了", "5 分钟内电脑上没有批准，这个请求作废了。") { _screen.value = Screen.Request(conn) }
                PairStatus.Pending -> Unit
            }
        }
    }

    /** 等批准时点「取消」 */
    fun cancelWaiting(conn: Connected) {
        job?.cancel()
        _screen.value = Screen.Request(conn)
    }

    // ---------------------------------------------------------------- 扫码

    /** 扫到的二维码（或从系统相机打开的 emaki://pair 链接） */
    fun onScanned(text: String) {
        val ticket = PairTicket.parse(text)
        if (ticket == null) {
            _screen.value = Screen.Failed("不是 Emaki 的二维码", "请扫电脑上 设置 →「手机访问」→「用二维码添加」里的二维码。", null)
            return
        }
        val first = ticket.addresses.first()
        _screen.value = Screen.Connecting(first, ticket.hosts.joinToString("、"))
        flow {
            // 挨个试二维码里的地址：证书要和二维码里的指纹一样，电脑标识也要一样
            var mismatch: HostPort? = null
            var lastError: Exception? = null
            for (a in ticket.addresses) {
                val conn = try {
                    pairing.connect(a, ticket.fingerprint)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: UpgradeRequiredException) {
                    _screen.value = Screen.Upgrade(e.minAppVersion)
                    return@flow
                } catch (e: Exception) {
                    if (e.fingerprintMismatch() != null) mismatch = a
                    lastError = e
                    continue
                }
                if (conn.hello.serverId != ticket.serverId) continue
                val approved = try {
                    conn.api.startPairWithTicket(_deviceName.value, DeviceInfo.model, ticket.ticket)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _screen.value = failure(e, a, null)
                    return@flow
                }
                paired(conn.hello, a, conn.fingerprint, approved)
                return@flow
            }
            _screen.value = when {
                mismatch != null -> Screen.CertWrong(null, mismatch)
                else -> Screen.Failed(
                    "连不上二维码里的电脑",
                    "试过了 ${ticket.hosts.joinToString("、")}，都没连上。${lastError?.let { describe(it) } ?: ""}".trim(),
                ) { onScanned(text) }
            }
        }
    }

    private fun paired(hello: Hello, address: HostPort, fingerprint: ByteArray, approved: PairStatus.Approved) {
        val s = SavedServer(
            serverId = hello.serverId,
            name = hello.name,
            fingerprint = Hex.encode(fingerprint),
            lastAddress = address,
            addresses = hello.addresses,
            port = hello.port,
            deviceId = approved.deviceId,
            token = approved.token,
        )
        store.save(s)
        _screen.value = Screen.Main(s, address)
    }

    // ---------------------------------------------------------------- 主界面（WebView）报上来的

    /**
     * 网页在 App 里遇到 401（window.EmakiApp.unpaired）：原生再问一次 /api/v1/me，确认是真的被移除了才换页；
     * 凭证其实还有效（Cookie 丢了之类）就重建 WebView 再来一次，还不行才算。
     */
    fun onWebUnpaired(main: Screen.Main, code: String) {
        if (_screen.value != main) return
        flow {
            val api = EmakiApi(main.address, main.server.fingerprintBytes)
            try {
                api.me(main.server.token)
                _screen.value = if (main.generation < 1) main.copy(generation = main.generation + 1)
                else Screen.Removed(main.server, main.address, revoked = false)
            } catch (e: ApiException) {
                _screen.value = if (e.unauthorized) Screen.Removed(main.server, main.address, e.revoked)
                else Screen.Removed(main.server, main.address, code == "device_revoked")
            } catch (e: IOException) {
                _screen.value = if (e.fingerprintMismatch() != null) Screen.CertWrong(main.server, main.address)
                else Screen.Offline(main.server, null)
            }
        }
    }

    /**
     * 网页连不上电脑了（window.EmakiApp.connectionLost，apps/web/src/lib/connection.ts）：原生对现在的地址发 hello 核实，
     * 通的话什么都不做（误报、短暂掉线），不通换到「电脑不在线」并自动重连
     */
    fun onWebConnectionLost(main: Screen.Main) = watch.verify(main, "网页报连不上")

    /** 网页的主页面加载失败（电脑关了、换了地址）：重新找 */
    fun onWebOffline(main: Screen.Main) {
        if (_screen.value != main) return
        reconnect(main.server)
    }

    /** WebView 遇到的证书和保存的指纹对不上 */
    fun onWebCertWrong(main: Screen.Main) {
        if (_screen.value != main) return
        job?.cancel()
        _screen.value = Screen.CertWrong(main.server, main.address)
    }

    // ---------------------------------------------------------------- 错误怎么说

    private fun failure(e: Exception, address: HostPort, retry: (() -> Unit)?): Screen = when {
        e is UpgradeRequiredException -> Screen.Upgrade(e.minAppVersion)
        e.fingerprintMismatch() != null -> Screen.CertWrong(store.load(), address)
        e is IOException -> Screen.Failed("连不上 $address", describe(e), retry)
        else -> Screen.Failed("请求没有成功", describe(e), retry)
    }

    private fun describe(e: Exception): String = when (e) {
        is ApiException -> e.message ?: "电脑返回了错误（${e.status}）"
        is NotEmakiException, is PairingClosedException, is UpgradeRequiredException -> e.message.orEmpty()
        is ProtocolException -> e.message.orEmpty()
        is java.net.SocketTimeoutException -> "等了很久没有回应：看看电脑开着、和手机在同一个网络里，地址和端口也对。"
        is java.net.ConnectException -> "连接被拒绝：看看电脑上的 Emaki 开着、设置 →「手机访问」已经打开，端口也对。"
        is java.net.UnknownHostException -> "找不到这个地址。"
        is java.net.NoRouteToHostException -> "到不了这个地址：看看手机和电脑在同一个网络里。"
        is javax.net.ssl.SSLException -> "加密连接没建立起来：这个地址上可能不是 Emaki 的局域网入口。"
        is IOException -> "网络出了问题：${e.message ?: e.javaClass.simpleName}"
        else -> e.message ?: e.javaClass.simpleName
    }

    private companion object {
        const val TAG = "Emaki"
    }
}
