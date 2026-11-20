package app.emaki.mobile.core

import java.net.InetSocketAddress
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/**
 * 证书固定（docs/mobile.md 3.2）：电脑的证书是自签的，不走系统的证书校验，只认配对时记下的那张（DER 的 sha256）。
 * 主机名也不校验：地址会变（换 IP、Tailscale），认的是证书本身。
 */
class FingerprintMismatchException(val expected: ByteArray, val actual: ByteArray?) :
    CertificateException("证书不对：期望 ${Hex.encode(expected)}，收到 ${actual?.let(Hex::encode) ?: "（没有证书）"}")

/** 只认一个指纹的 TrustManager：原生请求（OkHttp）都用它。不走系统的证书校验是有意的（自签证书，靠指纹） */
@Suppress("CustomX509TrustManager")
class PinnedTrustManager(private val expected: ByteArray) : X509TrustManager {
    init {
        require(expected.size == 32) { "指纹应该是 32 字节" }
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw FingerprintMismatchException(expected, null)
        val actual = fingerprintOf(leaf)
        if (!sameFingerprint(actual, expected)) throw FingerprintMismatchException(expected, actual)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("不接受客户端证书")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** 第一次连上时用：什么证书都接受，只记下它的指纹（之后同一条流程里的请求都用 PinnedTrustManager 认准它） */
@Suppress("CustomX509TrustManager")
class CapturingTrustManager : X509TrustManager {
    @Volatile
    var fingerprint: ByteArray? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("电脑没有给出证书")
        fingerprint = fingerprintOf(leaf)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("不接受客户端证书")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

object Tls {
    fun context(trustManager: X509TrustManager): SSLContext =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }

    /**
     * 连上 address 做一次 TLS 握手，返回证书指纹（第 0 步）。只握手，不发任何请求。
     * 给了 expected（扫码时二维码里的指纹）而对不上时抛 FingerprintMismatchException。
     */
    fun probeFingerprint(address: HostPort, timeoutMs: Int, expected: ByteArray? = null): ByteArray {
        val tm = CapturingTrustManager()
        val socket = context(tm).socketFactory.createSocket() as SSLSocket
        socket.use {
            it.soTimeout = timeoutMs
            it.connect(InetSocketAddress(address.host, address.port), timeoutMs)
            it.startHandshake()
        }
        val fp = tm.fingerprint ?: throw CertificateException("电脑没有给出证书")
        if (expected != null && !sameFingerprint(fp, expected)) throw FingerprintMismatchException(expected, fp)
        return fp
    }
}

/** 异常链里有没有「证书对不上」 */
fun Throwable.fingerprintMismatch(): FingerprintMismatchException? {
    var t: Throwable? = this
    var depth = 0
    while (t != null && depth++ < 10) {
        if (t is FingerprintMismatchException) return t
        t.suppressed.firstNotNullOfOrNull { it.fingerprintMismatch() }?.let { return it }
        t = t.cause
    }
    return null
}
