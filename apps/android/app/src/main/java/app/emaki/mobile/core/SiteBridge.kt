package app.emaki.mobile.core

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.UUID

/**
 * App 里的站内浏览（docs/plugins.md 第 6 节 site@1）：插件给一个外部网站（比如 Pixiv）用的脚本，App 打开网站本身时加载。
 * 这里是和安卓无关的部分（有单元测试）：电脑给的站点列表、页面里的调用怎么变成 Emaki 的请求、回复怎么写。
 *
 * 页面里的脚本经 window.__emakiSite.call(命令, 输入) 调这个插件自己的命令；App 用设备凭证转给电脑
 * （POST /api/plugins/<插件>/call，按「插件的授权 ∩ 这台设备的权限」）。别的插件的命令、Emaki 自己的命令一律不转。
 */
data class Site(
    val pluginId: String,
    val id: String,
    val title: String,
    val url: String,
    /** 在哪些网站上加载脚本（域名；pixiv.net 也算它的子域名） */
    val matches: List<String>,
    val code: String,
) {
    fun matches(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return matches.any {
            val m = it.lowercase().removePrefix("*.")
            h == m || h.endsWith(".$m")
        }
    }

    /**
     * 打开时先去哪：网页要打开到网站上的某个地址（插件接管的链接 link@1，比如图片来源的 Pixiv 作品页，docs/plugins.md 12.7），
     * 是这个网站的 https 地址就去那里，别的（不是 https、不是这个网站的、写错的）都去起始页
     */
    fun startUrl(requested: String?): String {
        if (requested.isNullOrBlank()) return url
        val uri = runCatching { java.net.URI(requested) }.getOrNull() ?: return url
        return if (uri.scheme.equals("https", ignoreCase = true) && uri.rawUserInfo == null && matches(uri.host)) requested else url
    }
}

object SiteBridge {
    /** GET /api/plugins/sites 的结果 */
    fun parseSites(text: String): List<Site> {
        val a = JSONArray(text)
        return List(a.length()) { i ->
            val o = a.getJSONObject(i)
            val m = o.getJSONArray("matches")
            Site(
                pluginId = o.getString("pluginId"),
                id = o.getString("id"),
                title = o.getString("title"),
                url = o.getString("url"),
                matches = List(m.length()) { m.getString(it) },
                code = o.getString("code"),
            )
        }
    }

    /** 命令名 → 工具名（和 @emaki/shared 的 commandToolName 一样）：pixiv-browser.download → pixiv-browser_download */
    fun toolName(command: String): String =
        command.replace('.', '_').replace(Regex("[A-Z]")) { "_" + it.value.lowercase() }

    /** 页面发来的一次调用 */
    data class Request(val rid: Long, val name: String, val args: JSONObject)

    /** 页面发来的消息 → 调用；不是这个插件自己的命令返回错误的说法 */
    fun parse(message: String, pluginId: String): Result<Request> = runCatching {
        val o = JSONObject(message)
        val rid = o.getLong("rid")
        val name = o.getString("name")
        val rest = name.removePrefix("$pluginId.")
        require(rest != name && rest.isNotEmpty() && !rest.contains('.')) { "只能调这个插件自己的命令（$pluginId.…）" }
        Request(rid, name, o.optJSONObject("args") ?: JSONObject())
    }

    /** POST /api/plugins/<插件>/call 的请求体：工具名、参数（写命令要 operationId，每次新给一个） */
    fun callBody(request: Request): String =
        JSONObject()
            .put("name", toolName(request.name))
            .put("arguments", JSONObject(request.args.toString()).put("operationId", UUID.randomUUID().toString()))
            .toString()

    /** 电脑回的结果（MCP 的 CallToolResult）→ 给页面的回复：出错的写原因；文本是 JSON 就原样给对象 */
    fun reply(rid: Long, result: String): String {
        val o = JSONObject(result)
        val first = o.optJSONArray("content")?.optJSONObject(0)
        val text = first?.optString("text")
        if (o.optBoolean("isError")) return failure(rid, text?.takeIf { it.isNotBlank() } ?: "调用失败")
        val value: Any = when {
            text == null -> JSONObject.NULL
            else -> runCatching { JSONTokener(text).nextValue() }.getOrDefault(text)
        }
        return JSONObject().put("rid", rid).put("ok", true).put("value", value).toString()
    }

    fun failure(rid: Long, error: String): String = JSONObject().put("rid", rid).put("ok", false).put("error", error).toString()

    /** 给页面的端口消息：带一次性口令，网页里的广告框这类冒充不了 */
    fun portMessage(nonce: String): String = "emaki-site:port:$nonce"

    /**
     * 先注入页面的一小段：window.__emakiSite.call(命令, 输入) → Promise。App 随后经 postWebMessage 把消息端口交给主页面
     * （只交给这个网站的主页面，消息里带 nonce）；端口到之前的调用先排着
     */
    fun bootstrap(nonce: String): String = """
(function () {
  if (window.__emakiSite) return;
  var port = null, seq = 0, pending = {}, queue = [];
  var key = ${JSONObject.quote(portMessage(nonce))};
  window.addEventListener('message', function (e) {
    if (port || e.data !== key || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = function (m) {
      var r;
      try { r = JSON.parse(m.data); } catch (x) { return; }
      var p = pending[r.rid];
      if (!p) return;
      delete pending[r.rid];
      if (r.ok) p.resolve(r.value); else p.reject(new Error(r.error || '调用失败'));
    };
    queue.splice(0).forEach(function (q) { port.postMessage(q); });
  });
  window.__emakiSite = {
    call: function (name, args) {
      return new Promise(function (resolve, reject) {
        var rid = ++seq;
        pending[rid] = { resolve: resolve, reject: reject };
        var msg = JSON.stringify({ rid: rid, name: name, args: args || {} });
        if (port) port.postMessage(msg); else queue.push(msg);
      });
    },
  };
})();
"""
}
