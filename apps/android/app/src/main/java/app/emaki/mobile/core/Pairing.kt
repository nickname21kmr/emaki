package app.emaki.mobile.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 电脑上的 Emaki 要求更新 App（hello 的 minAppVersion 比 App 新，或者协议版本比 App 认识的新） */
class UpgradeRequiredException(val minAppVersion: String, val appVersion: String) :
    Exception("电脑上的 Emaki 需要 App $minAppVersion 以上，这个 App 是 $appVersion，请先更新 App")

/** 这个地址上不是 Emaki */
class NotEmakiException : Exception("这个地址上不是 Emaki")

/** 电脑现在不接受新的连接请求（hello 的 pairing 是 false） */
class PairingClosedException : Exception("电脑现在不接受新的连接请求")

/** 连上了一台电脑：认准了证书（api 只认这个指纹），问过了 hello */
data class Connected(val api: EmakiApi, val hello: Hello) {
    val address: HostPort get() = api.address
    val fingerprint: ByteArray get() = api.fingerprint
}

/** 发出去、等电脑批准的请求：校验码是 App 自己算的 */
data class PairAttempt(val id: String, val code: String, val expiresAt: String)

/**
 * 配对的流程（apps/server/src/access/pairing.ts 文件头的协议，和 scripts/lan-client.ts 的 pair 一步一步对应）。
 * probe、newApi 可以换掉（单元测试里连假电脑）。
 */
class Pairing(
    private val appVersion: String,
    private val probe: suspend (HostPort, ByteArray?) -> ByteArray = { a, expected ->
        withContext(Dispatchers.IO) { Tls.probeFingerprint(a, EmakiApi.CONNECT_TIMEOUT_MS.toInt(), expected) }
    },
    private val newApi: (HostPort, ByteArray) -> EmakiApi = { a, fp -> EmakiApi(a, fp) },
) {
    /**
     * 第 0 步：连上，记下证书指纹（扫码时 expected 是二维码里的指纹，对不上抛 FingerprintMismatchException），
     * 之后这条流程里的请求都只认它；再问 hello，确认是 Emaki、协议和版本对得上。
     */
    suspend fun connect(address: HostPort, expected: ByteArray? = null): Connected {
        val fp = probe(address, expected)
        val api = newApi(address, fp)
        val hello = api.hello()
        check(hello, appVersion)
        return Connected(api, hello)
    }

    /** 第 1–3 步：提交 nonceA 的哈希 → 拿到 nonceB → 公开 nonceA → 自己算校验码 */
    suspend fun request(conn: Connected, name: String, model: String?, nonceA: ByteArray = PairCrypto.newNonce()): PairAttempt {
        if (!conn.hello.pairing) throw PairingClosedException()
        val started = conn.api.startPair(name, model, PairCrypto.commit(nonceA))
        val nonceB = Hex.decodeOrNull(started.nonce)?.takeIf { it.size == PairCrypto.NONCE_BYTES }
            ?: throw ProtocolException("电脑给的随机数格式不对")
        // 看到 nonceB 之后才公开 nonceA
        conn.api.reveal(started.id, Hex.encode(nonceA))
        return PairAttempt(started.id, PairCrypto.code(conn.fingerprint, nonceA, nonceB), started.expiresAt)
    }

    /** 第 4 步：长轮询，直到批准、拒绝或过期 */
    suspend fun awaitDecision(conn: Connected, attempt: PairAttempt): PairStatus {
        while (true) {
            val s = conn.api.pairStatus(attempt.id)
            if (s != PairStatus.Pending) return s
        }
    }

    companion object {
        /** hello 的检查：是不是 Emaki；协议版本、最低 App 版本 */
        fun check(hello: Hello, appVersion: String) {
            if (hello.app != "emaki") throw NotEmakiException()
            if (hello.protocol > Protocol.VERSION || Versions.tooOld(appVersion, hello.minAppVersion)) {
                throw UpgradeRequiredException(hello.minAppVersion, appVersion)
            }
            if (hello.protocol < Protocol.VERSION) throw ProtocolException("电脑上的 Emaki 太旧了，请先更新电脑上的 Emaki")
        }
    }
}
