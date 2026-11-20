package app.emaki.mobile.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CryptoTest {
    private fun bytes(v: Int) = ByteArray(32) { v.toByte() }

    @Test
    fun `校验码的测试向量（和电脑上 pairing ts 的一致）`() {
        assertEquals("559142", PairCrypto.code(bytes(0), bytes(0), bytes(0)))
        assertEquals("645456", PairCrypto.code(bytes(1), bytes(2), bytes(0)))
    }

    @Test
    fun `校验码总是 6 位，不够补零`() {
        // 随便几组输入：长度都是 6、全是数字
        for (i in 0 until 200) {
            val code = PairCrypto.code(bytes(i), bytes(i * 7), bytes(i * 13))
            assertEquals(6, code.length)
            assert(code.all(Char::isDigit))
        }
    }

    @Test
    fun `commit 是 nonceA 的 sha256 的 hex`() {
        // sha256(32 个 0x00)
        assertEquals("66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925", PairCrypto.commit(bytes(0)))
        val nonce = PairCrypto.newNonce()
        assertEquals(32, nonce.size)
        assertEquals(Hex.encode(sha256(nonce)), PairCrypto.commit(nonce))
    }

    @Test
    fun `校验码 3 + 3 分组`() {
        assertEquals("559 142", PairCrypto.group("559142"))
        assertEquals("012 345", PairCrypto.group("012345"))
    }

    @Test
    fun `hex 互转`() {
        val b = byteArrayOf(0, 1, 0x7f, -128, -1)
        assertEquals("00017f80ff", Hex.encode(b))
        assertArrayEquals(b, Hex.decode("00017F80FF"))
        assertNull(Hex.decodeOrNull("abc"))
        assertNull(Hex.decodeOrNull("zz"))
    }
}
