package app.emaki.mobile.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.security.MessageDigest

class PinningTest {
    private val a = HeldCertificate.Builder().commonName("Emaki a").build()
    private val b = HeldCertificate.Builder().commonName("Emaki b").build()
    private val server = MockWebServer()

    @After
    fun stop() = server.shutdown()

    @Test
    fun `指纹是证书 DER 的 sha256`() {
        val expected = MessageDigest.getInstance("SHA-256").digest(a.certificate.encoded)
        assertArrayEquals(expected, fingerprintOf(a.certificate))
        assertTrue(!fingerprintOf(a.certificate).contentEquals(fingerprintOf(b.certificate)))
    }

    @Test
    fun `TrustManager：指纹对上才接受`() {
        val tm = PinnedTrustManager(fingerprintOf(a.certificate))
        tm.checkServerTrusted(arrayOf(a.certificate), "RSA")
        try {
            tm.checkServerTrusted(arrayOf(b.certificate), "RSA")
            fail("换了证书应该拒绝")
        } catch (e: FingerprintMismatchException) {
            assertArrayEquals(fingerprintOf(b.certificate), e.actual)
        }
        try {
            tm.checkServerTrusted(emptyArray(), "RSA")
            fail("没有证书应该拒绝")
        } catch (e: FingerprintMismatchException) {
            assertEquals(null, e.actual)
        }
        // 只看第一张（电脑的证书），后面跟着什么都不算数
        try {
            tm.checkServerTrusted(arrayOf(b.certificate, a.certificate), "RSA")
            fail("第一张不对应该拒绝")
        } catch (_: FingerprintMismatchException) {
        }
    }

    @Test
    fun `第一次连接：什么证书都接受，记下指纹`() {
        val tm = CapturingTrustManager()
        tm.checkServerTrusted(arrayOf(b.certificate), "RSA")
        assertArrayEquals(fingerprintOf(b.certificate), tm.fingerprint)
    }

    private fun https(cert: HeldCertificate): HostPort {
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        server.start()
        return HostPort(server.hostName, server.port)
    }

    @Test
    fun `握手拿到电脑的证书指纹；二维码里的指纹对不上时拒绝`() {
        val address = https(a)
        assertArrayEquals(fingerprintOf(a.certificate), Tls.probeFingerprint(address, 3000))
        assertArrayEquals(fingerprintOf(a.certificate), Tls.probeFingerprint(address, 3000, fingerprintOf(a.certificate)))
        try {
            Tls.probeFingerprint(address, 3000, fingerprintOf(b.certificate))
            fail("指纹对不上应该拒绝")
        } catch (e: FingerprintMismatchException) {
            assertArrayEquals(fingerprintOf(a.certificate), e.actual)
        }
    }

    @Test
    fun `原生请求只认保存的指纹，对不上时一个请求都不发`() = runBlocking {
        val address = https(a)
        server.enqueue(MockResponse().setBody(HELLO).addHeader("content-type", "application/json"))
        val hello = EmakiApi(address, fingerprintOf(a.certificate)).hello()
        assertEquals("srv1", hello.serverId)
        assertEquals(1, server.requestCount)

        try {
            EmakiApi(address, fingerprintOf(b.certificate)).hello()
            fail("证书对不上应该失败")
        } catch (e: IOException) {
            assertNotNull(e.fingerprintMismatch())
        }
        assertEquals("证书对不上时服务端不该收到请求", 1, server.requestCount)
    }

    companion object {
        const val HELLO = """{"app":"emaki","protocol":1,"serverId":"srv1","name":"书房","version":"0.1.16","minAppVersion":"0.1.0","port":5175,"addresses":["192.168.1.5"],"pairing":true,"fingerprint":"00"}"""
    }
}
