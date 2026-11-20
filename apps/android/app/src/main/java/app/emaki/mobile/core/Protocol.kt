package app.emaki.mobile.core

import org.json.JSONException
import org.json.JSONObject

/**
 * 局域网入口上 App 原生部分用的接口（/api/v1/…，packages/shared/src/access.ts）和它们的 JSON。
 * 解析用安卓自带的 org.json；字段缺了、类型不对时抛 ProtocolException。
 */
object Protocol {
    /** App 支持的协议版本（hello 的 protocol、mDNS TXT 的 v） */
    const val VERSION = 1
}

class ProtocolException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** GET /api/v1/hello */
data class Hello(
    val app: String,
    val protocol: Int,
    val serverId: String,
    val name: String,
    val version: String,
    val minAppVersion: String,
    val port: Int,
    val addresses: List<String>,
    val pairing: Boolean,
)

/** POST /api/v1/pair 的响应（普通请求）：id 是这次请求的编号兼凭据，nonce 是电脑的随机数 nonceB（hex） */
data class PairStarted(val id: String, val nonce: String, val expiresAt: String)

/** GET /api/v1/pair/:id */
sealed interface PairStatus {
    data object Pending : PairStatus
    data class Approved(val deviceId: String, val token: String) : PairStatus
    data object Rejected : PairStatus
    data object Expired : PairStatus
}

/** GET /api/v1/me */
data class Me(val deviceId: String, val name: String, val scopes: List<String>)

/** 接口返回的错误 `{ ok: false, error, code }`（error 是给人看的中文） */
class ApiException(val status: Int, val code: String?, message: String) : Exception(message) {
    val revoked: Boolean get() = status == 401 && code == "device_revoked"
    val unauthorized: Boolean get() = status == 401 && (code == "unauthorized" || code == "device_revoked")
}

object Json {
    private inline fun <T> parse(what: String, text: String, block: (JSONObject) -> T): T =
        try {
            block(JSONObject(text))
        } catch (e: JSONException) {
            throw ProtocolException("电脑返回的$what 看不懂：${e.message}", e)
        }

    fun hello(text: String): Hello = parse("hello", text) { o ->
        val addresses = o.optJSONArray("addresses")
        Hello(
            app = o.optString("app"),
            protocol = o.getInt("protocol"),
            serverId = o.getString("serverId"),
            name = o.getString("name"),
            version = o.optString("version"),
            minAppVersion = o.optString("minAppVersion", "0"),
            port = o.getInt("port"),
            addresses = if (addresses == null) emptyList() else List(addresses.length()) { addresses.getString(it) },
            pairing = o.optBoolean("pairing", false),
        )
    }

    fun pairStarted(text: String): PairStarted = parse("请求结果", text) { o ->
        PairStarted(id = o.getString("id"), nonce = o.getString("nonce"), expiresAt = o.optString("expiresAt"))
    }

    fun pairStatus(text: String): PairStatus = parse("请求状态", text) { o ->
        when (val s = o.getString("status")) {
            "pending" -> PairStatus.Pending
            "approved" -> PairStatus.Approved(deviceId = o.getString("deviceId"), token = o.getString("token"))
            "rejected" -> PairStatus.Rejected
            "expired" -> PairStatus.Expired
            else -> throw ProtocolException("不认识的请求状态：$s")
        }
    }

    fun me(text: String): Me = parse("设备信息", text) { o ->
        val scopes = o.optJSONArray("scopes")
        Me(
            deviceId = o.getString("deviceId"),
            name = o.optString("name"),
            scopes = if (scopes == null) emptyList() else List(scopes.length()) { scopes.getString(it) },
        )
    }

    /** 失败的响应：尽量取出 code 和中文说明 */
    fun error(status: Int, text: String): ApiException {
        val o = runCatching { JSONObject(text) }.getOrNull()
        val code = o?.optString("code")?.takeIf { it.isNotEmpty() }
        val message = o?.optString("error")?.takeIf { it.isNotEmpty() } ?: "电脑返回了错误（$status）"
        return ApiException(status, code, message)
    }

    fun pairStartBody(name: String, model: String?, commit: String? = null, ticket: String? = null): String =
        JSONObject().apply {
            put("name", name)
            if (!model.isNullOrBlank()) put("model", model)
            if (commit != null) put("commit", commit)
            if (ticket != null) put("ticket", ticket)
        }.toString()

    fun revealBody(nonceHex: String): String = JSONObject().put("nonce", nonceHex).toString()

    // ---------------------------------------------------------------- 传图（docs/mobile.md 5.4）

    fun uploadCheckBody(files: List<Pair<String, Long>>): String =
        JSONObject().put("files", org.json.JSONArray(files.map { (sha, size) -> JSONObject().put("sha256", sha).put("size", size) })).toString()

    fun uploadCheck(text: String): Map<String, CheckHit> = parse("检查结果", text) { o ->
        val results = o.getJSONArray("results")
        (0 until results.length()).associate { i ->
            val r = results.getJSONObject(i)
            r.getString("sha256") to CheckHit(
                imageId = if (r.isNull("imageId")) null else r.getString("imageId"),
                deleted = r.optBoolean("deleted", false),
                dir = if (!r.has("dir") || r.isNull("dir")) null else r.getString("dir"),
            )
        }
    }

    fun uploadBeginBody(r: BeginRequest): String = JSONObject().apply {
        put("batchId", r.batchId)
        put("sha256", r.sha256)
        put("size", r.size)
        put("fileName", r.fileName)
        if (r.modifiedAt != null) put("modifiedAt", r.modifiedAt)
        if (r.album != null) put("album", r.album)
        if (r.clientKey != null) put("clientKey", r.clientKey)
    }.toString()

    fun uploadBegin(text: String): BeginResult = parse("开始上传的结果", text) { o ->
        BeginResult(
            uploadId = o.getString("uploadId"),
            received = o.getLong("received"),
            status = o.getString("status"),
            imageId = if (o.isNull("imageId")) null else o.optString("imageId"),
        )
    }

    fun uploadReceived(text: String): Long = parse("上传进度", text) { o -> o.getLong("received") }

    fun uploadComplete(text: String): CompleteResult = parse("上传结果", text) { o ->
        CompleteResult(status = o.getString("status"), imageId = o.getString("imageId"))
    }

    // ---------------------------------------------------------------- 同步相册（docs/mobile.md 5.5）

    fun albumReportBody(r: AlbumReport): String = JSONObject().apply {
        put("full", r.full)
        put("albums", org.json.JSONArray(r.albums.map { a ->
            JSONObject().apply {
                put("path", a.path)
                put("name", a.name)
                put("count", a.count)
                put("bytes", a.bytes)
                if (a.latestAt != null) put("latestAt", a.latestAt)
                a.inventory?.let { i ->
                    put("inventory", JSONObject().apply {
                        put("total", i.total)
                        put("have", i.have)
                        put("inTarget", i.inTarget)
                        put("deleted", i.deleted)
                        put("new", i.new)
                        put("newBytes", i.newBytes)
                        put("folder", i.folder ?: JSONObject.NULL)
                        put("folderCount", i.folderCount)
                    })
                }
                if (a.pending != null) put("pending", a.pending)
            }
        }))
        r.state?.let { st ->
            put("state", JSONObject().apply {
                put("running", st.running ?: JSONObject.NULL)
                if (st.done != null) put("done", st.done)
                if (st.total != null) put("total", st.total)
                if (st.error != null) put("error", st.error)
                if (st.summary != null) put("summary", st.summary)
            })
        }
    }.toString()

    fun albumConfig(text: String): AlbumConfig = parse("同步设置", text) { o ->
        val albums = o.optJSONArray("albums")
        AlbumConfig(
            wifiOnly = o.optBoolean("wifiOnly", true),
            chargingOnly = o.optBoolean("chargingOnly", false),
            syncing = if (albums == null) emptySet() else (0 until albums.length())
                .map { albums.getJSONObject(it) }
                .filter { it.optBoolean("sync", false) }
                .map { it.getString("path") }
                .toSet(),
        )
    }
}

/** 版本号比较：按点分的数字逐段比（「0.1.0」<「0.2.0」<「0.10.0」），不是数字的部分当 0 */
object Versions {
    private fun parts(v: String): List<Int> =
        v.trim().substringBefore('-').substringBefore('+').split('.').map { p -> p.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }

    fun compare(a: String, b: String): Int {
        val x = parts(a)
        val y = parts(b)
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }

    /** App 的版本低于电脑要求的最低版本 */
    fun tooOld(appVersion: String, minAppVersion: String): Boolean = compare(appVersion, minAppVersion) < 0
}
