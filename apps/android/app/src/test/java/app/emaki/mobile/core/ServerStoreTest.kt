package app.emaki.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ServerStoreTest {
    private class MapStore : KeyValueStore {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(values: Map<String, String?>) {
            for ((k, v) in values) if (v == null) map.remove(k) else map[k] = v
        }
    }

    /** 假的加密：每个字节异或，前面加一个标记（真的是 Keystore 的 AES-GCM） */
    private class XorBox : SecretBox {
        override fun seal(plain: ByteArray) = byteArrayOf(0x42) + plain.map { (it.toInt() xor 0x5a).toByte() }
        override fun open(sealed: ByteArray): ByteArray {
            require(sealed.firstOrNull() == 0x42.toByte()) { "坏了" }
            return sealed.drop(1).map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        }
    }

    private val kv = MapStore()
    private val store = ServerStore(kv, XorBox())
    private val server = SavedServer(
        serverId = "srv-1",
        name = "书房的电脑",
        fingerprint = "ab".repeat(32),
        lastAddress = HostPort("192.168.0.100", 5195),
        addresses = listOf("192.168.0.100", "100.64.0.7"),
        port = 5195,
        deviceId = "dev-1",
        token = "secret-token-value",
    )

    @Test
    fun `存了再读出来一样；凭证不是明文`() {
        assertNull(store.load())
        store.save(server)
        assertEquals(server, store.load())
        assertFalse(kv.map.values.any { it.contains("secret-token-value") })
        assertFalse(kv.map[ServerStore.KEY_SERVER]!!.contains("token"))
    }

    @Test
    fun `连上了：更新地址和 hello 给的信息`() {
        store.save(server)
        val hello = Hello("emaki", 1, "srv-1", "改了名", "0.1.16", "0.1.0", 5196, listOf("10.0.0.5"), true)
        val next = store.connected(HostPort("10.0.0.5", 5196), hello)!!
        assertEquals(HostPort("10.0.0.5", 5196), next.lastAddress)
        assertEquals("改了名", next.name)
        assertEquals(listOf("10.0.0.5"), next.addresses)
        assertEquals(5196, next.port)
        assertEquals(next, store.load())
        // hello 没给地址时保留原来的
        val again = store.connected(HostPort("10.0.0.6", 5196), hello.copy(addresses = emptyList()))!!
        assertEquals(listOf("10.0.0.5"), again.addresses)
    }

    @Test
    fun `读不出来（解不开、格式坏了）当作没配对过`() {
        store.save(server)
        kv.map[ServerStore.KEY_TOKEN] = "AAAA"
        assertNull(store.load())
        store.save(server)
        kv.map[ServerStore.KEY_SERVER] = "{"
        assertNull(store.load())
        store.save(server.copy(fingerprint = "abcd"))
        assertNull(store.load())
    }

    @Test
    fun `忘记这台电脑；设备名称`() {
        store.save(server)
        store.setDeviceName("  我的手机 ")
        store.clear()
        assertNull(store.load())
        assertEquals("我的手机", store.deviceName())
        store.setDeviceName(" ")
        assertNull(store.deviceName())
    }
}
