package app.emaki.mobile.core

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

/**
 * 对一台电脑的一个地址发原生请求（OkHttp）。每个连接都只认 fingerprint 这张证书（PinnedTrustManager），不校验主机名；
 * 证书对不上时握手就失败，一个请求字节都不会发出去。
 *
 * 接口见 apps/server/src/access/lan.ts 的 lanRoutes：hello、pair、pair/:id/reveal、pair/:id（长轮询）、me。
 */
class EmakiApi(
    val address: HostPort,
    val fingerprint: ByteArray,
    base: OkHttpClient = defaultClient,
    connectTimeoutMs: Long = CONNECT_TIMEOUT_MS,
) {
    private val client: OkHttpClient = run {
        val tm = PinnedTrustManager(fingerprint)
        base.newBuilder()
            .sslSocketFactory(Tls.context(tm).socketFactory, tm)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(connectTimeoutMs, TimeUnit.MILLISECONDS)
            .build()
    }

    /** 长轮询要等 25 秒，读超时放宽 */
    private val longPoll: OkHttpClient = client.newBuilder().readTimeout(MAX_WAIT_S + 15L, TimeUnit.SECONDS).build()

    suspend fun hello(): Hello = Json.hello(call(get("/api/v1/hello")))

    /** 第 1 步：提交 nonceA 的哈希，拿到请求编号和电脑的 nonceB */
    suspend fun startPair(name: String, model: String?, commit: String): PairStarted =
        Json.pairStarted(call(post("/api/v1/pair", Json.pairStartBody(name, model, commit = commit))))

    /** 扫码：带一次性口令，电脑直接批准，返回凭证 */
    suspend fun startPairWithTicket(name: String, model: String?, ticket: String): PairStatus.Approved {
        val status = Json.pairStatus(call(post("/api/v1/pair", Json.pairStartBody(name, model, ticket = ticket))))
        return status as? PairStatus.Approved ?: throw ProtocolException("扫码请求没有直接批准（$status）")
    }

    /** 第 2 步：看到 nonceB 之后公开 nonceA */
    suspend fun reveal(id: String, nonceAHex: String) {
        call(post("/api/v1/pair/${encode(id)}/reveal", Json.revealBody(nonceAHex)))
    }

    /** 第 4 步：请求的状态；还在等时电脑最多挂 waitS 秒再回答 */
    suspend fun pairStatus(id: String, waitS: Int = MAX_WAIT_S): PairStatus =
        Json.pairStatus(call(get("/api/v1/pair/${encode(id)}?wait=$waitS"), longPoll))

    /** 凭证还有效时返回这台设备；被移除了抛 ApiException（401 device_revoked） */
    suspend fun me(token: String): Me =
        Json.me(call(get("/api/v1/me").newBuilder().header("Authorization", "Bearer $token").build()))

    /** 传图的接口（docs/mobile.md 5.4）：每个请求带设备凭证；一段最多 8 MiB，写超时放宽 */
    fun uploads(token: String): UploadApi = object : UploadApi {
        private val slow: OkHttpClient = client.newBuilder().writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build()

        private fun auth(r: Request): Request = r.newBuilder().header("Authorization", "Bearer $token").build()

        override suspend fun check(files: List<Pair<String, Long>>): Map<String, String?> =
            Json.uploadCheck(call(auth(post("/api/uploads/check", Json.uploadCheckBody(files)))))

        override suspend fun begin(request: BeginRequest): BeginResult =
            Json.uploadBegin(call(auth(post("/api/uploads", Json.uploadBeginBody(request)))))

        override suspend fun put(uploadId: String, offset: Long, bytes: ByteArray, length: Int): Long {
            val body = bytes.toRequestBody(OCTETS, 0, length)
            val r = Request.Builder().url(address.url("/api/uploads/${encode(uploadId)}?offset=$offset")).header("Accept", "application/json").put(body).build()
            return Json.uploadReceived(call(auth(r), slow))
        }

        override suspend fun complete(uploadId: String): CompleteResult =
            Json.uploadComplete(call(auth(post("/api/uploads/${encode(uploadId)}/complete", "{}")), slow))
    }

    private fun get(path: String): Request =
        Request.Builder().url(address.url(path)).header("Accept", "application/json").get().build()

    private fun post(path: String, json: String): Request =
        Request.Builder().url(address.url(path)).header("Accept", "application/json").post(json.toRequestBody(JSON)).build()

    /** 发请求，返回 2xx 的响应体；否则抛 ApiException。网络问题是 IOException（证书对不上时异常链里有 FingerprintMismatchException） */
    private suspend fun call(request: Request, http: OkHttpClient = client): String {
        val response = http.newCall(request).await()
        return response.use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw Json.error(r.code, text)
            text
        }
    }

    private fun encode(id: String): String = java.net.URLEncoder.encode(id, "UTF-8")

    companion object {
        /** 局域网里连一个地址最多等这么久（连不上就换下一个） */
        const val CONNECT_TIMEOUT_MS = 4_000L
        const val MAX_WAIT_S = 25
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val OCTETS = "application/octet-stream".toMediaType()

        val defaultClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .readTimeout(15, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .build()
        }
    }
}

/** OkHttp 的 Call 变成可取消的挂起函数：协程取消时请求也取消（长轮询中途点「取消」） */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            @Suppress("DEPRECATION")
            cont.resume(response) { _ -> response.close() }
        }

        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
