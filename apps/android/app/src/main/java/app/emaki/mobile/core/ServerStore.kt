package app.emaki.mobile.core

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/** 配对过的那台电脑（第一版只连一台） */
data class SavedServer(
    /** 电脑的固定标识（hello 的 serverId、mDNS TXT 的 id） */
    val serverId: String,
    val name: String,
    /** 证书指纹（DER 的 sha256，hex）：只认这一张 */
    val fingerprint: String,
    /** 上次连上的地址 */
    val lastAddress: HostPort,
    /** hello 给的全部地址（电脑所有网卡的 IPv4）和端口 */
    val addresses: List<String>,
    val port: Int,
    val deviceId: String,
    /** 设备凭证（存的时候用 Keystore 的密钥加密） */
    val token: String,
) {
    val fingerprintBytes: ByteArray get() = Hex.decode(fingerprint)
}

/** 简单的键值存储（SharedPreferences；测试里用 Map） */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(values: Map<String, String?>)
}

/** 加密、解密少量数据（Android Keystore 里的 AES-GCM 密钥；测试里用假的） */
interface SecretBox {
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray
}

/**
 * 保存配对结果：电脑的信息明文存，凭证用 SecretBox 加密后存（base64）。
 * 读不出来（格式不对、Keystore 的密钥没了）时当作没配对过。
 */
class ServerStore(private val kv: KeyValueStore, private val box: SecretBox) {
    fun load(): SavedServer? {
        val info = kv.get(KEY_SERVER) ?: return null
        val sealed = kv.get(KEY_TOKEN) ?: return null
        return runCatching {
            val o = JSONObject(info)
            val token = String(box.open(Base64.getDecoder().decode(sealed)), Charsets.UTF_8)
            val addresses = o.getJSONArray("addresses")
            SavedServer(
                serverId = o.getString("serverId"),
                name = o.getString("name"),
                fingerprint = o.getString("fingerprint"),
                lastAddress = HostPort(o.getString("lastHost"), o.getInt("lastPort")),
                addresses = List(addresses.length()) { addresses.getString(it) },
                port = o.getInt("port"),
                deviceId = o.getString("deviceId"),
                token = token,
            )
        }.getOrNull()?.takeIf { Hex.decodeOrNull(it.fingerprint)?.size == 32 && it.token.isNotEmpty() }
    }

    fun save(s: SavedServer) {
        val info = JSONObject()
            .put("serverId", s.serverId)
            .put("name", s.name)
            .put("fingerprint", s.fingerprint)
            .put("lastHost", s.lastAddress.host)
            .put("lastPort", s.lastAddress.port)
            .put("addresses", JSONArray(s.addresses))
            .put("port", s.port)
            .put("deviceId", s.deviceId)
        val sealed = Base64.getEncoder().encodeToString(box.seal(s.token.toByteArray(Charsets.UTF_8)))
        kv.put(mapOf(KEY_SERVER to info.toString(), KEY_TOKEN to sealed))
    }

    /** 这次从 address 连上了：记下地址，顺便更新 hello 给的名称、地址和端口 */
    fun connected(address: HostPort, hello: Hello?): SavedServer? {
        val s = load() ?: return null
        val next = s.copy(
            lastAddress = address,
            name = hello?.name ?: s.name,
            addresses = hello?.addresses?.takeIf { it.isNotEmpty() } ?: s.addresses,
            port = hello?.port ?: s.port,
        )
        if (next != s) save(next)
        return next
    }

    /** 忘记这台电脑 */
    fun clear() {
        kv.put(mapOf(KEY_SERVER to null, KEY_TOKEN to null))
    }

    /** 这台手机在电脑上显示的名字（自己改过的；没改过是 null） */
    fun deviceName(): String? = kv.get(KEY_DEVICE_NAME)?.takeIf { it.isNotBlank() }

    fun setDeviceName(name: String?) {
        kv.put(mapOf(KEY_DEVICE_NAME to name?.trim()?.takeIf { it.isNotEmpty() }))
    }

    companion object {
        const val KEY_SERVER = "server"
        const val KEY_TOKEN = "token"
        const val KEY_DEVICE_NAME = "deviceName"
    }
}
