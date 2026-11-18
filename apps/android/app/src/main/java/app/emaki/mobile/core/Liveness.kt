package app.emaki.mobile.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * 主界面上核实连接（docs/mobile.md 3.6）：网页报连不上（window.EmakiApp.connectionLost）、App 回到前台、手机换了网络时，
 * 对现在的地址发一次 `GET /api/v1/hello`：只认保存的证书指纹（EmakiApi），最多等 2 秒，serverId 对得上才算通。
 */
class LinkCheck(
    private val timeoutMs: Long = TIMEOUT_MS,
    private val newApi: (HostPort, ByteArray) -> EmakiApi = { a, fp -> EmakiApi(a, fp, connectTimeoutMs = timeoutMs) },
) {
    suspend fun alive(server: SavedServer, address: HostPort): Boolean =
        withTimeoutOrNull(timeoutMs) {
            try {
                newApi(address, server.fingerprintBytes).hello().serverId == server.serverId
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
        } ?: false

    companion object {
        const val TIMEOUT_MS = 2_000L
    }
}

/** 「电脑不在线」页面上自动重连的间隔：3、5、10、20 秒，之后一直 30 秒 */
class Backoff(private val steps: List<Long> = STEPS) {
    private var i = 0

    fun next(): Long = steps[minOf(i, steps.lastIndex)].also { i++ }

    fun reset() {
        i = 0
    }

    companion object {
        val STEPS = listOf(3_000L, 5_000L, 10_000L, 20_000L, 30_000L)
    }
}

/**
 * 网页的请求靠 Cookie 认证（docs/mobile.md 3.5）：打开网页前给 `https://<地址>:<端口>/` 写 `emaki_device=<凭证>`，写好了再加载。
 * 每次建 WebView 都写（WebScreen）：重连到新地址时 Cookie 跟着写到新地址上。
 */
object DeviceCookie {
    /** apps/server/src/access/lan.ts 的 DEVICE_COOKIE */
    const val NAME = "emaki_device"

    fun value(token: String): String = "$NAME=$token; Secure; HttpOnly; SameSite=Strict; Path=/"

    /** set(url, value, done)：给这个地址的 / 写 Cookie，写好了调 done；然后 load 这个地址上的 path（断线前看的那一页，默认首页） */
    fun open(
        address: HostPort,
        token: String,
        path: String = "/",
        set: (url: String, value: String, done: () -> Unit) -> Unit,
        load: (String) -> Unit,
    ) {
        set(address.url("/"), value(token)) { load(address.url(if (path.startsWith("/")) path else "/")) }
    }
}
