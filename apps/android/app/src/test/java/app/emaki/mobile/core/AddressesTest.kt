package app.emaki.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AddressesTest {
    @Test
    fun `手动输入的地址`() {
        assertEquals(HostPort("192.168.1.5", 5175), Addresses.parse("192.168.1.5"))
        assertEquals(HostPort("192.168.1.5", 5195), Addresses.parse(" 192.168.1.5:5195 "))
        assertEquals(HostPort("192.168.1.5", 5195), Addresses.parse("https://192.168.1.5:5195/library?x=1"))
        assertEquals(HostPort("desktop.local", 5175), Addresses.parse("desktop.local"))
        assertEquals(HostPort("fe80::1", 5175), Addresses.parse("[fe80::1]"))
        assertEquals(HostPort("fe80::1", 8443), Addresses.parse("[fe80::1]:8443"))
        assertEquals(HostPort("fe80::1", 5175), Addresses.parse("fe80::1"))
        assertEquals("[fe80::1]:8443", HostPort("fe80::1", 8443).toString())
        assertEquals("https://192.168.1.5:5175/api/v1/hello", HostPort("192.168.1.5", 5175).url("/api/v1/hello"))
    }

    @Test
    fun `写错的地址`() {
        assertNull(Addresses.parse(""))
        assertNull(Addresses.parse("   "))
        assertNull(Addresses.parse("192.168.1.5:"))
        assertNull(Addresses.parse("192.168.1.5:0"))
        assertNull(Addresses.parse("192.168.1.5:70000"))
        assertNull(Addresses.parse("192.168.1.5:abc"))
        assertNull(Addresses.parse("192.168 .1.5"))
        assertNull(Addresses.parse(":5175"))
        assertNull(Addresses.parse("[fe80::1"))
    }

    @Test
    fun `候选地址：NSD 找到的、上次的、hello 给的，去重`() {
        val list = Addresses.candidates(
            discovered = HostPort("192.168.1.9", 5175),
            last = HostPort("192.168.1.5", 5175),
            known = listOf("192.168.1.5", "100.64.0.7", " ", "192.168.1.9", "10.0.0.2"),
            knownPort = 5175,
        )
        assertEquals(
            listOf(HostPort("192.168.1.9", 5175), HostPort("192.168.1.5", 5175), HostPort("100.64.0.7", 5175), HostPort("10.0.0.2", 5175)),
            list,
        )
        // 端口不同就不算重复
        assertEquals(
            listOf(HostPort("192.168.1.5", 5195), HostPort("192.168.1.5", 5175)),
            Addresses.candidates(null, HostPort("192.168.1.5", 5195), listOf("192.168.1.5"), 5175),
        )
        assertEquals(emptyList<HostPort>(), Addresses.candidates(null, null, emptyList(), 5175))
    }
}
