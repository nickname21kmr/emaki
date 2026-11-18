package app.emaki.mobile.core

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * 假电脑：照 apps/server/src/access/pairing.ts 和 lan.ts 的协议回答（https、自签证书）。
 * 校验码在这里按协议重新算一遍（不用 App 的 PairCrypto），App 算的要和它一样。
 */
class FakeComputer(
    val serverId: String = "srv-1",
    val name: String = "书房的电脑",
    val cert: HeldCertificate = HeldCertificate.Builder().commonName("Emaki $serverId").build(),
    var minAppVersion: String = "0.1.0",
    var addresses: List<String> = listOf("192.168.1.5"),
    var port: Int = 5175,
) {
    val server = MockWebServer()
    val fingerprint: ByteArray = MessageDigest.getInstance("SHA-256").digest(cert.certificate.encoded)

    /** 电脑认的凭证 → 设备 id；撤销了的放进 revoked */
    val tokens = ConcurrentHashMap<String, String>()
    val revoked = ConcurrentHashMap.newKeySet<String>()

    /** 等批准的请求：id → 状态 */
    class Req(val commit: String, val nonceB: ByteArray, var code: String? = null, var decision: String? = null)
    val requests = ConcurrentHashMap<String, Req>()
    val tickets = ConcurrentHashMap.newKeySet<String>()

    /** 长轮询：前几次回 pending，然后按 decide 决定 */
    @Volatile var pendingPolls = 1
    @Volatile var decide: (Req) -> String = { "approved" }

    val address: HostPort get() = HostPort(server.hostName, server.port)

    fun start(): FakeComputer {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        server.start()
        return this
    }

    fun stop() = server.shutdown()

    private fun json(status: Int, body: Any) = MockResponse().setResponseCode(status).addHeader("content-type", "application/json").setBody(body.toString())
    private fun error(status: Int, code: String, msg: String) = json(status, JSONObject().put("ok", false).put("code", code).put("error", msg))

    private fun code(nonceA: ByteArray, nonceB: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update("emaki-pair-v1".toByteArray(Charsets.UTF_8))
        md.update(fingerprint)
        md.update(nonceA)
        md.update(nonceB)
        val n = ByteBuffer.wrap(md.digest(), 0, 4).int.toLong() and 0xffffffffL
        return (n % 1_000_000).toString().padStart(6, '0')
    }

    private fun handle(r: RecordedRequest): MockResponse {
        val path = r.path ?: ""
        val p = path.substringBefore('?')
        return when {
            r.method == "GET" && p == "/api/v1/hello" -> json(
                200,
                JSONObject().put("app", "emaki").put("protocol", 1).put("serverId", serverId).put("name", name)
                    .put("version", "0.1.16").put("minAppVersion", minAppVersion).put("port", port)
                    .put("addresses", JSONArray(addresses)).put("pairing", true).put("fingerprint", Hex.encode(fingerprint)),
            )
            r.method == "POST" && p == "/api/v1/pair" -> {
                if (r.getHeader("content-type")?.startsWith("application/json") != true) return error(415, "bad_request", "请求必须是 JSON")
                val body = JSONObject(r.body.clone().readUtf8())
                if (body.has("ticket")) {
                    if (!tickets.remove(body.getString("ticket"))) return error(403, "forbidden", "二维码已经过期或用过了，请在电脑上重新生成")
                    val token = "tok-ticket-${tokens.size}"
                    tokens[token] = "dev-${tokens.size}"
                    return json(200, JSONObject().put("status", "approved").put("deviceId", tokens[token]).put("token", token))
                }
                val id = "k${requests.size + 1}"
                val nonceB = ByteArray(32).also { SecureRandom().nextBytes(it) }
                requests[id] = Req(body.getString("commit"), nonceB)
                json(200, JSONObject().put("id", id).put("nonce", Hex.encode(nonceB)).put("expiresAt", "2099-01-01T00:00:00.000Z"))
            }
            r.method == "POST" && p.startsWith("/api/v1/pair/") && p.endsWith("/reveal") -> {
                val req = requests[p.removePrefix("/api/v1/pair/").removeSuffix("/reveal")] ?: return error(404, "not_found", "这个请求不存在或已经过期")
                if (req.code != null) return error(409, "conflict", "这个请求已经公开过随机数了")
                val nonceA = Hex.decode(JSONObject(r.body.clone().readUtf8()).getString("nonce"))
                if (Hex.encode(MessageDigest.getInstance("SHA-256").digest(nonceA)) != req.commit) return error(400, "bad_request", "随机数和之前提交的对不上")
                req.code = code(nonceA, req.nonceB)
                json(200, JSONObject().put("ok", true))
            }
            r.method == "GET" && p.startsWith("/api/v1/pair/") -> {
                val id = p.removePrefix("/api/v1/pair/")
                val req = requests[id] ?: return json(200, JSONObject().put("status", "expired"))
                if (pendingPolls > 0) {
                    pendingPolls--
                    return json(200, JSONObject().put("status", "pending"))
                }
                requests.remove(id)
                when (val d = decide(req)) {
                    "approved" -> {
                        val token = "tok-$id"
                        tokens[token] = "dev-$id"
                        json(200, JSONObject().put("status", "approved").put("deviceId", "dev-$id").put("token", token))
                    }
                    else -> json(200, JSONObject().put("status", d))
                }
            }
            r.method == "GET" && p == "/api/v1/me" -> {
                val token = r.getHeader("Authorization")?.removePrefix("Bearer ")
                val device = token?.let { tokens[it] } ?: return error(401, "unauthorized", "需要先在电脑上批准这台设备")
                if (device in revoked) return error(401, "device_revoked", "这台设备已经被电脑移除，请重新请求连接")
                json(200, JSONObject().put("deviceId", device).put("name", "Pixel").put("scopes", JSONArray(listOf("read"))))
            }
            else -> error(404, "not_found", "没有这个接口")
        }
    }
}
