package app.emaki.mobile.ui

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.emaki.mobile.BuildConfig
import app.emaki.mobile.core.HostPort
import app.emaki.mobile.core.SavedServer
import app.emaki.mobile.core.fingerprintOf
import app.emaki.mobile.core.sameFingerprint

/** 网页里的选文件（B1 用）交给 Activity 打开系统的选择器 */
fun interface FileChooser {
    fun choose(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean
}

/** 设备凭证的 Cookie（apps/server/src/access/lan.ts 的 DEVICE_COOKIE） */
const val DEVICE_COOKIE = "emaki_device"

/**
 * 主界面：全屏 WebView 加载电脑上的网页 `https://<地址>:<端口>/`（docs/mobile.md 3.1）。
 *
 * - 加载前给这个地址写 Cookie `emaki_device=<凭证>`（网页的请求靠它认证）；
 * - 证书：onReceivedSslError 里比对证书 DER 的 sha256，等于保存的指纹才 proceed，否则 cancel，换到「证书不对」；
 * - 外部链接（不是电脑的地址）用系统浏览器打开；返回键先在网页里后退；支持选文件；
 * - 注入 `window.EmakiApp`：网页遇到 401（设备被移除）时调 `unpaired(code)`，App 回到原生页面，不显示网页自己的配对页；
 *   `paper(color)` 是 App 自己注入的脚本用的，把网页的纸色报上来，状态栏、导航栏跟着换颜色。
 */
@Composable
fun WebScreen(
    server: SavedServer,
    address: HostPort,
    generation: Int,
    fileChooser: FileChooser,
    onPaper: (Color) -> Unit,
    onUnpaired: (String) -> Unit,
    onCertWrong: () -> Unit,
    onOffline: () -> Unit,
) {
    val context = LocalContext.current
    val p = LocalPaper.current
    var paper by remember { mutableStateOf(p.canvas) }
    var canGoBack by remember { mutableStateOf(false) }
    var progress by remember { mutableFloatStateOf(0f) }
    // WebView 只建一次，回调要拿到最新的
    val latestUnpaired by rememberUpdatedState(onUnpaired)
    val latestCertWrong by rememberUpdatedState(onCertWrong)
    val latestOffline by rememberUpdatedState(onOffline)
    val latestPaper by rememberUpdatedState(onPaper)

    val webView = remember(server.serverId, address, generation) {
        createWebView(
            context,
            address,
            server.fingerprintBytes,
            fileChooser,
            object : WebEvents {
                override fun history(view: WebView) {
                    canGoBack = view.canGoBack()
                }

                override fun progress(value: Int) {
                    progress = value / 100f
                }

                override fun paper(color: Color) {
                    paper = color
                    latestPaper(color)
                }

                override fun unpaired(code: String) = latestUnpaired(code)
                override fun certWrong() = latestCertWrong()
                override fun offline() = latestOffline()
            },
        ).also { it.setBackgroundColor(p.canvas.toArgb()) }
    }

    DisposableEffect(webView) {
        // 先写 Cookie 再加载
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setCookie(address.url("/"), "$DEVICE_COOKIE=${server.token}; Secure; HttpOnly; SameSite=Strict; Path=/") {
            cookies.flush()
            webView.loadUrl(address.url("/"))
        }
        onDispose {
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
    }

    BackHandler(enabled = canGoBack) { webView.goBack() }

    Box(Modifier.fillMaxSize().background(paper)) {
        AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize().safeDrawingPadding().testTag("web"))
        if (progress < 1f) {
            LinearProgressIndicator(
                progress = { progress.coerceAtLeast(0.05f) },
                color = p.shu,
                trackColor = Color.Transparent,
                modifier = Modifier.fillMaxWidth().height(2.dp).safeDrawingPadding().align(Alignment.TopCenter),
            )
        }
    }
}

private interface WebEvents {
    fun history(view: WebView)
    fun progress(value: Int)
    fun paper(color: Color)
    fun unpaired(code: String)
    fun certWrong()
    fun offline()
}

/** 网页的纸色：读 <html> 上的 --c-canvas，主题、底色变了再报（ThemeSync 改的是 data-theme / data-palette） */
private const val PAPER_JS = """
(function () {
  if (window.__emakiPaper) return; window.__emakiPaper = true;
  var root = document.documentElement;
  var last = '';
  function send() {
    var c = getComputedStyle(root).getPropertyValue('--c-canvas').trim();
    if (c && c !== last && window.EmakiApp && window.EmakiApp.paper) { last = c; window.EmakiApp.paper(c); }
  }
  new MutationObserver(send).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-palette', 'class', 'style'] });
  send();
})();
"""

/** 「#ece8e0」「#fff」「rgb(13 12 11)」→ 颜色；看不懂返回 null */
fun parseCssColor(text: String): Color? {
    val s = text.trim().lowercase()
    if (s.startsWith("#")) {
        val hex = s.substring(1)
        val full = when (hex.length) {
            3 -> hex.map { "$it$it" }.joinToString("")
            6 -> hex
            else -> return null
        }
        val v = full.toLongOrNull(16) ?: return null
        return Color(0xFF000000 or v)
    }
    val m = Regex("""rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)""").find(s) ?: return null
    val (r, g, b) = m.destructured
    return Color(r.toInt().coerceIn(0, 255), g.toInt().coerceIn(0, 255), b.toInt().coerceIn(0, 255))
}

@SuppressLint("SetJavaScriptEnabled")
private fun createWebView(
    context: Context,
    address: HostPort,
    fingerprint: ByteArray,
    fileChooser: FileChooser,
    events: WebEvents,
): WebView {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    val main = Handler(Looper.getMainLooper())
    val web = WebView(context)
    // 一定要 MATCH_PARENT：AndroidView 默认给 WRAP_CONTENT，WebView 会按内容定高，网页的 height: 100% 变成 0，整页空白
    web.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    var certFailed = false

    fun isComputer(uri: Uri?): Boolean {
        if (uri == null || uri.scheme != "https") return false
        val port = if (uri.port == -1) 443 else uri.port
        return uri.host.equals(address.host, ignoreCase = true) && port == address.port
    }

    web.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        setSupportMultipleWindows(false)
        // 网页、服务端的日志里能看出是 App
        userAgentString = "$userAgentString EmakiApp/${BuildConfig.VERSION_NAME}"
    }

    web.addJavascriptInterface(
        object {
            @JavascriptInterface
            fun unpaired(code: String?) {
                main.post { events.unpaired(code ?: "unauthorized") }
            }

            @JavascriptInterface
            fun paper(color: String?) {
                val c = color?.let(::parseCssColor) ?: return
                main.post { events.paper(c) }
            }
        },
        "EmakiApp",
    )

    web.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (isComputer(uri)) return false
            val scheme = uri.scheme?.lowercase()
            if (scheme == "about" || scheme == "data" || scheme == "blob" || scheme == "javascript") return false
            // 外部链接（Pixiv 等）：系统浏览器
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "没有能打开 $uri 的应用")
            }
            return true
        }

        // 自签证书一定会走到这里：证书 DER 的 sha256 和配对时记下的一样才放行，其余一律 cancel
        @Suppress("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val cert = error.certificate?.x509Certificate
            val ours = isComputer(Uri.parse(error.url))
            if (ours && cert != null && sameFingerprint(fingerprintOf(cert), fingerprint)) {
                handler.proceed()
                return
            }
            handler.cancel()
            Log.w(TAG, "证书对不上：${error.url}")
            if (ours) {
                certFailed = true
                events.certWrong()
            }
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            events.progress(0)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            events.progress(100)
            if (isComputer(Uri.parse(url ?: ""))) view.evaluateJavascript(PAPER_JS, null)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            events.history(view)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame || certFailed || !isComputer(request.url)) return
            Log.w(TAG, "主页面没加载出来：${error.errorCode} ${error.description}")
            when (error.errorCode) {
                ERROR_CONNECT, ERROR_HOST_LOOKUP, ERROR_TIMEOUT, ERROR_IO, ERROR_FAILED_SSL_HANDSHAKE -> events.offline()
            }
        }
    }

    web.webChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            events.progress(newProgress)
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean = fileChooser.choose(filePathCallback, fileChooserParams)
    }
    return web
}

private const val TAG = "EmakiWeb"
