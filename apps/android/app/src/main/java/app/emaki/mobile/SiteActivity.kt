package app.emaki.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import app.emaki.mobile.core.EmakiApi
import app.emaki.mobile.core.HostPort
import app.emaki.mobile.core.Site
import app.emaki.mobile.core.SiteApi
import app.emaki.mobile.core.SiteBridge
import app.emaki.mobile.platform.serverStore
import app.emaki.mobile.ui.EmakiTheme
import app.emaki.mobile.ui.LocalPaper
import app.emaki.mobile.ui.Muted
import app.emaki.mobile.ui.Notice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * App 里的站内浏览（docs/plugins.md 第 6 节 site@1）：在 App 里打开插件对应的外部网站本身（比如 Pixiv），网站原来的样子、功能都不动，
 * 加载插件给它的脚本（多选、「下载到 Emaki」这类按钮）。
 *
 * - 单独一个 WebView：网站的 Cookie 在 App 里一直留着，在这里登录一次就记住（和手机浏览器是分开的）；
 * - 每次整页加载完，在插件声明的网站（matches）上注入：先一小段引导代码（window.__emakiSite），再插件的脚本；
 *   然后用系统的消息通道把一个端口交给这个网站的主页面（postWebMessage 指定来源，消息带一次性口令），页面里的广告框拿不到；
 * - 页面经端口发来的调用：只认这个插件自己的命令，用设备凭证转给电脑（POST /api/plugins/<插件>/call），结果原样回给页面；
 * - 网站里点到的 http(s) 链接都在这里打开（登录页、作品页），别的（pixiv:// 这类拉起别的 App 的）不管；
 * - 返回键先在网站里后退，退到头回到 Emaki；顶上「关闭」直接回去；
 * - 从图片来源的链接打开的（插件接管的链接 link@1，docs/plugins.md 12.7）：直接打开到那个地址（这个网站的才行，Site.startUrl）。
 */
class SiteActivity : ComponentActivity() {
    private var site by mutableStateOf<Site?>(null)
    private var error by mutableStateOf<String?>(null)
    private var progress by mutableFloatStateOf(0f)
    private var canGoBack by mutableStateOf(false)
    private var pageTitle by mutableStateOf("")
    private var web: WebView? = null
    private var api: SiteApi? = null
    /**
     * 交给页面的端口：每次整页加载一个。单页应用在页面里跳转时 WebView 也会报「加载完」，那时页面还在用原来的端口，
     * 所以不另建；回复发回请求来的那个端口
     */
    private val ports = mutableListOf<WebMessagePort>()
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        val pluginId = intent.getStringExtra(EXTRA_PLUGIN).orEmpty()
        val siteId = intent.getStringExtra(EXTRA_SITE).orEmpty()
        val host = intent.getStringExtra(EXTRA_HOST).orEmpty()
        val portNo = intent.getIntExtra(EXTRA_PORT, 0)
        val saved = serverStore(this).load()
        if (saved == null || host.isEmpty() || portNo == 0) {
            error = "还没有连上电脑"
        } else {
            val a = EmakiApi(HostPort(host, portNo), saved.fingerprintBytes).sites(saved.token)
            api = a
            lifecycleScope.launch {
                try {
                    // EmakiApi 读响应在调用的线程上：不能在主线程
                    val text = withContext(Dispatchers.IO) { a.list() }
                    val s = SiteBridge.parseSites(text).firstOrNull { it.pluginId == pluginId && it.id == siteId }
                    if (s == null) error = "这个网站的插件停用了，或者电脑上没有它" else site = s
                } catch (e: Exception) {
                    Log.w(TAG, "取站点脚本失败", e)
                    error = "连不上电脑：${e.message ?: e.javaClass.simpleName}"
                }
            }
        }
        setContent {
            EmakiTheme {
                Screen()
            }
        }
    }

    override fun onDestroy() {
        ports.forEach { runCatching { it.close() } }
        web?.let {
            it.stopLoading()
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        CookieManager.getInstance().flush()
        super.onDestroy()
    }

    @Composable
    private fun Screen() {
        val p = LocalPaper.current
        val s = site
        BackHandler(enabled = canGoBack) { web?.goBack() }
        Column(Modifier.fillMaxSize().background(p.canvas).safeDrawingPadding()) {
            // 顶栏放在上层、自己有底色：嵌进来的 WebView 不会自动裁剪，画出界时不能盖住它
            Row(
                Modifier.fillMaxWidth().zIndex(1f).background(p.canvas).height(44.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { finish() }, modifier = Modifier.testTag("site:close")) {
                    Text("← Emaki", color = p.fg, fontSize = 14.sp)
                }
                Text(
                    text = s?.title?.let { t -> if (pageTitle.isNotBlank()) "$t · $pageTitle" else t } ?: "",
                    color = p.fgMuted,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                )
                if (canGoBack) {
                    TextButton(onClick = { web?.goBack() }) { Text("后退", color = p.fg, fontSize = 14.sp) }
                }
            }
            Box(Modifier.fillMaxSize().clipToBounds()) {
                when {
                    error != null -> Column(Modifier.padding(24.dp)) { Notice(error!!, danger = true) }
                    s == null -> Muted("正在打开…", Modifier.padding(24.dp))
                    else -> AndroidView(factory = { ctx -> createWebView(ctx, s) }, modifier = Modifier.fillMaxSize().clipToBounds().testTag("site:web"))
                }
                if (s != null && progress < 1f) {
                    LinearProgressIndicator(
                        progress = { progress.coerceAtLeast(0.05f) },
                        color = p.shu,
                        trackColor = Color.Transparent,
                        modifier = Modifier.fillMaxWidth().height(2.dp).align(Alignment.TopCenter),
                    )
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(context: Context, s: Site): WebView {
        val w = WebView(context)
        web = w
        w.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            // 网站的登录页可能用到别的域名（验证码）
            setAcceptThirdPartyCookies(w, true)
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme?.lowercase()
                // 网站里的链接都在这里打开；拉起别的 App 的（pixiv://、intent://）不管
                return scheme != "http" && scheme != "https"
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                progress = 0f
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress = 1f
                inject(view, s, url)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                canGoBack = view.canGoBack()
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress = newProgress / 100f
            }

            override fun onReceivedTitle(view: WebView, title: String?) {
                pageTitle = title?.removeSuffix(" - pixiv")?.removeSuffix(" [pixiv]")?.trim().orEmpty()
            }
        }
        w.loadUrl(s.startUrl(intent.getStringExtra(EXTRA_URL)))
        return w
    }

    /** 整页加载完：在插件声明的网站上注入引导代码和插件的脚本，再把消息端口交给主页面 */
    private fun inject(view: WebView, s: Site, url: String?) {
        val uri = Uri.parse(url ?: return)
        if (uri.scheme != "https" || !s.matches(uri.host)) return
        val nonce = UUID.randomUUID().toString()
        // 页面里已经有桥接（单页应用在页面里跳转）：不再注入
        view.evaluateJavascript("!!window.__emakiSite") { has ->
            if (has == "true") return@evaluateJavascript
            connect(view, s, uri, nonce)
        }
    }

    private fun connect(view: WebView, s: Site, uri: Uri, nonce: String) {
        view.evaluateJavascript("${SiteBridge.bootstrap(nonce)}\n;${s.code}\n;true") {
            // 只交给这个网站的主页面（期间跳到了别的网站，消息就不会送到）
            val (ours, theirs) = view.createWebMessageChannel()
            ports += ours
            ours.setWebMessageCallback(
                object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(p: WebMessagePort, message: WebMessage) {
                        handle(p, s, message.data ?: return)
                    }
                },
                main,
            )
            view.postWebMessage(WebMessage(SiteBridge.portMessage(nonce), arrayOf(theirs)), Uri.parse("https://${uri.host}"))
        }
    }

    /** 页面发来的一次调用：只认这个插件自己的命令，转给电脑，结果回给页面 */
    private fun handle(p: WebMessagePort, s: Site, data: String) {
        val request = SiteBridge.parse(data, s.pluginId)
        val rid = runCatching { org.json.JSONObject(data).optLong("rid") }.getOrDefault(0L)
        val r = request.getOrElse {
            runCatching { p.postMessage(WebMessage(SiteBridge.failure(rid, it.message ?: "调用不对"))) }
            return
        }
        val a = api ?: return
        lifecycleScope.launch {
            val reply = try {
                SiteBridge.reply(r.rid, withContext(Dispatchers.IO) { a.call(s.pluginId, SiteBridge.callBody(r)) })
            } catch (e: Exception) {
                SiteBridge.failure(r.rid, e.message ?: "连不上电脑")
            }
            // 端口关了（页面换了）就算了
            runCatching { p.postMessage(WebMessage(reply)) }
        }
    }

    companion object {
        private const val TAG = "EmakiSite"
        private const val EXTRA_PLUGIN = "plugin"
        private const val EXTRA_SITE = "site"
        private const val EXTRA_HOST = "host"
        private const val EXTRA_PORT = "port"
        private const val EXTRA_URL = "url"

        /** url：打开到网站上的这个地址（不是这个网站的就去起始页，Site.startUrl）；null 是起始页 */
        fun intent(context: Context, address: HostPort, pluginId: String, siteId: String, url: String? = null): Intent =
            Intent(context, SiteActivity::class.java)
                .putExtra(EXTRA_PLUGIN, pluginId)
                .putExtra(EXTRA_SITE, siteId)
                .putExtra(EXTRA_HOST, address.host)
                .putExtra(EXTRA_PORT, address.port)
                .putExtra(EXTRA_URL, url)
    }
}
