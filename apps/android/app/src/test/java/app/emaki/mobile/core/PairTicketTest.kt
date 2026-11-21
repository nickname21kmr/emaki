package app.emaki.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PairTicketTest {
    private val fp = "ab".repeat(32)

    @Test
    fun `电脑上 createTicket 生成的二维码`() {
        val t = PairTicket.parse("emaki://pair?id=3f9a&fp=$fp&p=5175&h=192.168.1.5,100.64.0.7&t=Zm9vYmFy_-x")
        assertNotNull(t)
        t!!
        assertEquals("3f9a", t.serverId)
        assertEquals(fp, Hex.encode(t.fingerprint))
        assertEquals(5175, t.port)
        assertEquals(listOf("192.168.1.5", "100.64.0.7"), t.hosts)
        assertEquals("Zm9vYmFy_-x", t.ticket)
        assertEquals(listOf(HostPort("192.168.1.5", 5175), HostPort("100.64.0.7", 5175)), t.addresses)
    }

    @Test
    fun `大小写、编码过的逗号、重复的地址`() {
        val t = PairTicket.parse("EMAKI://pair?t=x&h=10.0.0.2%2C10.0.0.2,%20&p=5195&fp=${fp.uppercase()}&id=s")
        assertNotNull(t)
        assertEquals(listOf("10.0.0.2"), t!!.hosts)
        assertEquals(5195, t.port)
    }

    @Test
    fun `缺项、格式不对、不是 Emaki 的二维码`() {
        val ok = "emaki://pair?id=s&fp=$fp&p=5175&h=192.168.1.5&t=x"
        assertNotNull(PairTicket.parse(ok))
        assertNull(PairTicket.parse("https://example.com/?id=s"))
        assertNull(PairTicket.parse("emaki://other?id=s&fp=$fp&p=5175&h=1.2.3.4&t=x"))
        assertNull(PairTicket.parse(ok.replace("id=s&", "")))
        assertNull(PairTicket.parse(ok.replace(fp, "abcd")))
        assertNull(PairTicket.parse(ok.replace("p=5175", "p=0")))
        assertNull(PairTicket.parse(ok.replace("p=5175", "p=x")))
        assertNull(PairTicket.parse(ok.replace("h=192.168.1.5", "h=")))
        assertNull(PairTicket.parse(ok.replace("&t=x", "")))
    }
}
