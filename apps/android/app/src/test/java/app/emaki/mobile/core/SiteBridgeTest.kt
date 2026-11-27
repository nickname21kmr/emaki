package app.emaki.mobile.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 站内浏览的桥接（SiteBridge）：站点列表、只放行插件自己的命令、请求体、回复 */
class SiteBridgeTest {
    private val sites = """
        [{"pluginId":"pixiv-browser","version":"0.3.0","id":"pixiv","title":"Pixiv","url":"https://www.pixiv.net/",
          "matches":["www.pixiv.net"],"script":"site/pixiv.js","code":"window.__x = 1;"}]
    """.trimIndent()

    @Test
    fun `站点列表和域名`() {
        val s = SiteBridge.parseSites(sites).single()
        assertEquals("pixiv-browser", s.pluginId)
        assertEquals("https://www.pixiv.net/", s.url)
        assertEquals("window.__x = 1;", s.code)
        assertTrue(s.matches("www.pixiv.net"))
        assertTrue(s.matches("WWW.PIXIV.NET"))
        assertFalse(s.matches("accounts.pixiv.net"))
        assertFalse(s.matches("evilwww.pixiv.net"))
        assertFalse(s.matches(null))
        assertTrue(s.copy(matches = listOf("pixiv.net")).matches("accounts.pixiv.net"))
    }

    @Test
    fun `打开到网站上的地址：只认这个网站的 https 地址，别的去起始页`() {
        val s = SiteBridge.parseSites(sites).single()
        assertEquals("https://www.pixiv.net/", s.startUrl(null))
        assertEquals("https://www.pixiv.net/", s.startUrl(""))
        assertEquals("https://www.pixiv.net/artworks/123", s.startUrl("https://www.pixiv.net/artworks/123"))
        assertEquals("https://www.pixiv.net/en/artworks/123?x=1", s.startUrl("https://www.pixiv.net/en/artworks/123?x=1"))
        assertEquals("https://www.pixiv.net/", s.startUrl("http://www.pixiv.net/artworks/123"))
        assertEquals("https://www.pixiv.net/", s.startUrl("https://evil.example/artworks/123"))
        assertEquals("https://www.pixiv.net/", s.startUrl("https://u:p@www.pixiv.net/artworks/123"))
        assertEquals("https://www.pixiv.net/", s.startUrl("javascript:alert(1)"))
        assertEquals("https://www.pixiv.net/", s.startUrl("https://www.pixiv.net/a b"))
    }

    @Test
    fun `工具名和 shared 的 commandToolName 一样`() {
        assertEquals("pixiv-browser_download", SiteBridge.toolName("pixiv-browser.download"))
        assertEquals("curation_set_favorite", SiteBridge.toolName("curation.setFavorite"))
    }

    @Test
    fun `只放行这个插件自己的命令`() {
        val ok = SiteBridge.parse("""{"rid":3,"name":"pixiv-browser.status","args":{"ids":["1"]}}""", "pixiv-browser").getOrThrow()
        assertEquals(3L, ok.rid)
        assertEquals("1", ok.args.getJSONArray("ids").getString(0))
        for (name in listOf("library.import", "other.download", "pixiv-browser.", "pixiv-browser.a.b", "pixiv-browserx.status"))
            assertTrue(name, SiteBridge.parse("""{"rid":1,"name":"$name"}""", "pixiv-browser").isFailure)
        assertTrue(SiteBridge.parse("不是 JSON", "pixiv-browser").isFailure)
    }

    @Test
    fun `请求体带工具名和新的 operationId`() {
        val r = SiteBridge.parse("""{"rid":1,"name":"pixiv-browser.download","args":{"works":[{"id":"5"}]}}""", "pixiv-browser").getOrThrow()
        val a = JSONObject(SiteBridge.callBody(r))
        val b = JSONObject(SiteBridge.callBody(r))
        assertEquals("pixiv-browser_download", a.getString("name"))
        assertEquals("5", a.getJSONObject("arguments").getJSONArray("works").getJSONObject(0).getString("id"))
        assertTrue(a.getJSONObject("arguments").getString("operationId").isNotEmpty())
        assertFalse(a.getJSONObject("arguments").getString("operationId") == b.getJSONObject("arguments").getString("operationId"))
        // 原来的参数没被改
        assertFalse(r.args.has("operationId"))
    }

    @Test
    fun `回复：JSON 原样给对象，出错写原因`() {
        val ok = JSONObject(SiteBridge.reply(7, """{"content":[{"type":"text","text":"{\"message\":\"已开始\",\"jobId\":\"j\"}"}]}"""))
        assertEquals(7L, ok.getLong("rid"))
        assertTrue(ok.getBoolean("ok"))
        assertEquals("已开始", ok.getJSONObject("value").getString("message"))
        val text = JSONObject(SiteBridge.reply(8, """{"content":[{"type":"text","text":"不是 JSON"}]}"""))
        assertEquals("不是 JSON", text.getString("value"))
        val err = JSONObject(SiteBridge.reply(9, """{"isError":true,"content":[{"type":"text","text":"这个插件没有权限"}]}"""))
        assertFalse(err.getBoolean("ok"))
        assertEquals("这个插件没有权限", err.getString("error"))
    }

    @Test
    fun `引导代码带口令`() {
        val js = SiteBridge.bootstrap("abc")
        assertTrue(js.contains("\"emaki-site:port:abc\""))
        assertTrue(js.contains("window.__emakiSite"))
        assertEquals("emaki-site:port:abc", SiteBridge.portMessage("abc"))
    }
}
