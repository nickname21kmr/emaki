package app.emaki.mobile.core

import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException

/** 重连的结果 */
sealed interface ReconnectResult {
    /** 连上了：地址、hello、凭证有效 */
    data class Online(val address: HostPort, val hello: Hello, val me: Me) : ReconnectResult

    /** 电脑认出了这台电脑、证书也对，但凭证不认了：revoked 是被移除了（device_revoked），否则是电脑不认识这个凭证（unauthorized） */
    data class Removed(val address: HostPort, val hello: Hello, val revoked: Boolean) : ReconnectResult

    /** 电脑上的 Emaki 要求更新 App */
    data class Upgrade(val minAppVersion: String) : ReconnectResult

    /** 哪个地址都没连上。certMismatch：有地址上的设备证书对不上（可能是别的设备占了这个地址，也可能有人冒充） */
    data class Offline(val tried: List<HostPort>, val certMismatch: HostPort?) : ReconnectResult
}

/**
 * 之后每次打开（docs/mobile.md 2.4）：在几个候选地址里找到配对过的那台电脑。
 *
 * 候选：局域网里按电脑标识找到的（NSD，最多 3 秒）、上次连上的、hello 给过的其他地址。
 * 每个候选都要 hello 的 serverId 对得上、证书指纹对得上（EmakiApi 只认保存的指纹）才用，然后 `GET /api/v1/me`。
 *
 * 为了不让每次打开都多等：上次的地址和 NSD 同时开始；NSD 找到的新地址立即试；
 * 过 OTHERS_DELAY_MS 还没连上，再同时试 hello 给过的其他地址。哪个先对得上就用哪个（对得上的都是同一台电脑）。
 */
class Reconnector(
    private val appVersion: String,
    private val newApi: (HostPort, ByteArray) -> EmakiApi = { a, fp -> EmakiApi(a, fp) },
    private val nsdTimeoutMs: Long = NSD_TIMEOUT_MS,
    private val othersDelayMs: Long = OTHERS_DELAY_MS,
) {
    /** 一个地址试下来的结果：decisive 是能直接下结论的（连上了、被移除、要更新），否则是「不是这台」 */
    private data class Attempt(val address: HostPort, val decisive: ReconnectResult?, val mismatch: Boolean)

    /** 试一个地址 */
    suspend fun tryAddress(saved: SavedServer, address: HostPort): ReconnectResult? = attempt(saved, address).decisive

    private suspend fun attempt(saved: SavedServer, address: HostPort): Attempt {
        val api = newApi(address, saved.fingerprintBytes)
        val hello = try {
            api.hello()
        } catch (e: Exception) {
            return Attempt(address, null, e.fingerprintMismatch() != null)
        }
        // 证书对上了，但 serverId 对不上：不可能是同一台（换证书要连 serverId 一起伪造），当作不是这台
        if (hello.serverId != saved.serverId || hello.app != "emaki") return Attempt(address, null, false)
        try {
            Pairing.check(hello, appVersion)
        } catch (e: UpgradeRequiredException) {
            return Attempt(address, ReconnectResult.Upgrade(e.minAppVersion), false)
        } catch (e: Exception) {
            return Attempt(address, null, false)
        }
        return try {
            Attempt(address, ReconnectResult.Online(address, hello, api.me(saved.token)), false)
        } catch (e: ApiException) {
            if (e.unauthorized) Attempt(address, ReconnectResult.Removed(address, hello, e.revoked), false)
            else Attempt(address, null, false)
        } catch (e: IOException) {
            Attempt(address, null, e.fingerprintMismatch() != null)
        } catch (e: ProtocolException) {
            Attempt(address, null, false)
        }
    }

    private sealed interface Event {
        data class Done(val attempt: Attempt) : Event
        /** NSD 找完了（没找到是 null） */
        data class Found(val address: HostPort?) : Event
        /** 过了 othersDelayMs */
        data object Later : Event
    }

    /** discover：在局域网里按电脑标识找（找不到返回 null；超过 nsdTimeoutMs 不再等） */
    suspend fun run(saved: SavedServer, discover: suspend () -> HostPort?): ReconnectResult = coroutineScope {
        val events = Channel<Event>(Channel.UNLIMITED)
        val tried = LinkedHashSet<HostPort>()
        val others = Addresses.candidates(null, null, saved.addresses, saved.port)
        var running = 0
        var nsdDone = false
        var othersStarted = false
        var mismatch: HostPort? = null

        // tried、running 只在这个协程里改；每个地址在子协程里试，结果从 events 回来
        fun start(a: HostPort) {
            if (!tried.add(a)) return
            running++
            launch { events.send(Event.Done(attempt(saved, a))) }
        }

        fun startOthers() {
            if (othersStarted) return
            othersStarted = true
            others.forEach(::start)
        }

        start(saved.lastAddress)
        launch { events.send(Event.Found(withTimeoutOrNull(nsdTimeoutMs) { discover() })) }
        launch {
            delay(othersDelayMs)
            events.send(Event.Later)
        }
        try {
            while (!(nsdDone && othersStarted && running == 0)) {
                when (val e = events.receive()) {
                    is Event.Done -> {
                        running--
                        e.attempt.decisive?.let { return@coroutineScope it }
                        if (e.attempt.mismatch && mismatch == null) mismatch = e.attempt.address
                        // 上次的地址不通：不用等，马上试其他地址
                        if (e.attempt.address == saved.lastAddress) startOthers()
                    }
                    is Event.Found -> {
                        nsdDone = true
                        e.address?.let(::start)
                    }
                    Event.Later -> startOthers()
                }
                if (nsdDone && running == 0) startOthers()
            }
            ReconnectResult.Offline(tried.toList(), mismatch)
        } finally {
            coroutineContext.cancelChildren()
        }
    }

    companion object {
        const val NSD_TIMEOUT_MS = 3_000L
        const val OTHERS_DELAY_MS = 1_500L
    }
}
