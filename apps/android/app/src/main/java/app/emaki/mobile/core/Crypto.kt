package app.emaki.mobile.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate

/** 小写 hex 和字节互转 */
object Hex {
    private const val DIGITS = "0123456789abcdef"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(DIGITS[v ushr 4]).append(DIGITS[v and 0x0f])
        }
        return out.toString()
    }

    /** 不是合法的 hex（长度为奇数、有别的字符）时返回 null */
    fun decodeOrNull(text: String): ByteArray? {
        val s = text.trim().lowercase()
        if (s.length % 2 != 0) return null
        val out = ByteArray(s.length / 2)
        for (i in out.indices) {
            val hi = DIGITS.indexOf(s[i * 2])
            val lo = DIGITS.indexOf(s[i * 2 + 1])
            if (hi < 0 || lo < 0) return null
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    fun decode(text: String): ByteArray = decodeOrNull(text) ?: throw IllegalArgumentException("不是 hex：$text")
}

fun sha256(vararg parts: ByteArray): ByteArray {
    val md = MessageDigest.getInstance("SHA-256")
    for (p in parts) md.update(p)
    return md.digest()
}

/** 证书指纹 = 证书 DER 的 sha256（和电脑上 cert.ts 的 fingerprintOf 一样） */
fun fingerprintOf(cert: X509Certificate): ByteArray = sha256(cert.encoded)

/** 两个指纹是否相同（定长比较） */
fun sameFingerprint(a: ByteArray?, b: ByteArray?): Boolean = a != null && b != null && MessageDigest.isEqual(a, b)

/**
 * 配对的密码学部分（apps/server/src/access/pairing.ts 文件头第 1–3 步）：
 * commit = hex(sha256(nonceA))；校验码 = sha256(utf8("emaki-pair-v1") ‖ fp ‖ nonceA ‖ nonceB) 前 4 字节大端无符号 mod 1 000 000，补零到 6 位。
 */
object PairCrypto {
    const val NONCE_BYTES = 32
    private val DOMAIN = "emaki-pair-v1".toByteArray(Charsets.UTF_8)
    private val random = SecureRandom()

    fun newNonce(): ByteArray = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }

    fun commit(nonceA: ByteArray): String = Hex.encode(sha256(nonceA))

    fun code(fingerprint: ByteArray, nonceA: ByteArray, nonceB: ByteArray): String {
        val h = sha256(DOMAIN, fingerprint, nonceA, nonceB)
        val n = ((h[0].toLong() and 0xff) shl 24) or
            ((h[1].toLong() and 0xff) shl 16) or
            ((h[2].toLong() and 0xff) shl 8) or
            (h[3].toLong() and 0xff)
        return (n % 1_000_000).toString().padStart(6, '0')
    }

    /** 「123 456」：3 + 3 分组，和电脑上的写法一样 */
    fun group(code: String): String = if (code.length == 6) "${code.substring(0, 3)} ${code.substring(3)}" else code
}
