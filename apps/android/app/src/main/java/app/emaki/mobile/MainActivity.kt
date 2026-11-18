package app.emaki.mobile

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.emaki.mobile.platform.FoundServer
import app.emaki.mobile.ui.AddressDialog
import app.emaki.mobile.ui.BusyScreen
import app.emaki.mobile.ui.CertWrongScreen
import app.emaki.mobile.ui.DeviceNameDialog
import app.emaki.mobile.ui.EmakiTheme
import app.emaki.mobile.ui.FailedScreen
import app.emaki.mobile.ui.FileChooser
import app.emaki.mobile.ui.FindScreen
import app.emaki.mobile.ui.ForgetDialog
import app.emaki.mobile.ui.LocalPaper
import app.emaki.mobile.ui.OfflineScreen
import app.emaki.mobile.ui.RemovedScreen
import app.emaki.mobile.ui.RequestScreen
import app.emaki.mobile.ui.UpgradeScreen
import app.emaki.mobile.ui.WaitingScreen
import app.emaki.mobile.ui.WebScreen
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
    private val model: AppModel by viewModels()

    /** 网页里选文件：等系统选择器返回 */
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val data = r.data
        val clip = data?.clipData
        val uris: Array<Uri>? = when {
            r.resultCode != RESULT_OK -> null
            clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
            else -> WebChromeClient.FileChooserParams.parseResult(r.resultCode, data)
        }
        pendingFiles?.onReceiveValue(uris)
        pendingFiles = null
    }

    private val fileChooser = FileChooser { callback, params ->
        pendingFiles?.onReceiveValue(null)
        pendingFiles = callback
        try {
            pickFiles.launch(params.createIntent())
            true
        } catch (e: ActivityNotFoundException) {
            pendingFiles = null
            false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handlePairLink(intent)
        setContent {
            EmakiTheme {
                App(model, fileChooser, ::setBarIcons)
            }
        }
    }

    // 在前台时才探（docs/mobile.md 3.6）：回到前台核实一次连接，「电脑不在线」页面上自动重连；到后台就停，省电
    override fun onResume() {
        super.onResume()
        model.foreground(true)
        watchNetwork(true)
    }

    override fun onPause() {
        watchNetwork(false)
        model.foreground(false)
        super.onPause()
    }

    /** 手机换了网络（离开 Wi-Fi、换到移动数据）：不等网页报，马上核实 */
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private fun watchNetwork(on: Boolean) {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        networkCallback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        networkCallback = null
        if (!on) return
        val callback = object : ConnectivityManager.NetworkCallback() {
            // 注册时系统先报一次现在的网络，那次不算「换了」
            private var initial = cm.activeNetwork != null

            override fun onAvailable(network: Network) {
                if (initial) {
                    initial = false
                    return
                }
                runOnUiThread { model.networkChanged() }
            }

            override fun onLost(network: Network) {
                initial = false
                runOnUiThread { model.networkChanged() }
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(callback) }.onSuccess { networkCallback = callback }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairLink(intent)
    }

    /** 用系统相机扫了电脑上的二维码，打开的是 emaki://pair?… */
    private fun handlePairLink(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "emaki" && uri.host == "pair") model.onScanned(uri.toString())
    }

    /** 状态栏、导航栏的图标：浅底用深色图标 */
    private fun setBarIcons(lightBackground: Boolean) {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = lightBackground
            isAppearanceLightNavigationBars = lightBackground
        }
    }
}

private sealed interface Dialog {
    data object Manual : Dialog
    data object ChangeAddress : Dialog
    data object Name : Dialog
    data object Forget : Dialog
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun App(model: AppModel, fileChooser: FileChooser, setBarIcons: (Boolean) -> Unit) {
    val screen by model.screen.collectAsStateWithLifecycle()
    val deviceName by model.deviceName.collectAsStateWithLifecycle()
    var dialog by remember { mutableStateOf<Dialog?>(null) }
    var webPaper by remember { mutableStateOf<Color?>(null) }
    val paper = LocalPaper.current

    val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let(model::onScanned)
    }
    val startScan = {
        scan.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("对准电脑上「用二维码添加」的二维码")
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    // 状态栏图标：主界面跟网页的纸色，原生页面跟系统深浅
    val barsLight = when (screen) {
        is Screen.Main -> (webPaper ?: paper.canvas).luminance() > 0.5f
        else -> !paper.dark
    }
    SideEffect { setBarIcons(barsLight) }

    // 请求连接中途按返回：回到找电脑（配对过的话重新连一次）
    val backToStart = {
        if (model.savedServer != null) model.reconnect() else model.goFind()
    }

    Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        when (val s = screen) {
            is Screen.Find -> {
                val found by remember { model.discovery.browse() }.collectAsStateWithLifecycle(emptyList<FoundServer>())
                FindScreen(
                    found = found,
                    deviceName = deviceName,
                    onPick = { model.connect(it.address, it.name) },
                    onScan = startScan,
                    onManual = { dialog = Dialog.Manual },
                    onEditName = { dialog = Dialog.Name },
                )
            }
            is Screen.Reconnecting -> BusyScreen("正在连接", "正在找「${s.name}」…")
            is Screen.Connecting -> {
                BackHandler { backToStart() }
                BusyScreen("连接到电脑", "正在连接 ${s.label}…", onCancel = backToStart)
            }
            is Screen.Request -> {
                BackHandler { backToStart() }
                RequestScreen(s.conn.hello, s.conn.address, deviceName, model::setDeviceName, { model.request(s.conn) }, backToStart)
            }
            is Screen.Waiting -> {
                BackHandler { model.cancelWaiting(s.conn) }
                WaitingScreen(s.conn.hello.name, s.attempt) { model.cancelWaiting(s.conn) }
            }
            is Screen.Main -> WebScreen(
                server = s.server,
                address = s.address,
                generation = s.generation,
                path = s.path,
                fileChooser = fileChooser,
                onPaper = { webPaper = it },
                onPath = { model.onWebPath(s, it) },
                onUnpaired = { code -> model.onWebUnpaired(s, code) },
                onConnectionLost = { model.onWebConnectionLost(s) },
                onCertWrong = { model.onWebCertWrong(s) },
                onOffline = { model.onWebOffline(s) },
            )
            is Screen.Offline -> OfflineScreen(
                s.server,
                s.certMismatch,
                s.note,
                trying = s.trying,
                onRetry = model::retryNow,
                onChangeAddress = { dialog = Dialog.ChangeAddress },
                onForget = { dialog = Dialog.Forget },
            )
            is Screen.Removed -> RemovedScreen(
                s.server,
                s.revoked,
                onRequestAgain = { model.requestAgain(s.server, s.address) },
                onForget = { dialog = Dialog.Forget },
            )
            is Screen.Upgrade -> UpgradeScreen(
                s.minAppVersion,
                BuildConfig.VERSION_NAME,
                onRetry = backToStart,
                onForget = model.savedServer?.let { { dialog = Dialog.Forget } },
            )
            is Screen.CertWrong -> CertWrongScreen(
                s.server,
                s.address,
                onRetry = backToStart,
                onForget = { if (s.server != null) dialog = Dialog.Forget else model.goFind() },
            )
            is Screen.Failed -> {
                BackHandler { backToStart() }
                FailedScreen(s.title, s.message, s.retry, backToStart)
            }
        }

        when (dialog) {
            Dialog.Manual -> AddressDialog("手动输入地址", "", { a ->
                dialog = null
                model.connect(a)
            }, { dialog = null })
            Dialog.ChangeAddress -> AddressDialog("换一个地址试试", "", { a ->
                dialog = null
                model.tryAddress(a)
            }, { dialog = null })
            Dialog.Name -> DeviceNameDialog(deviceName, {
                model.setDeviceName(it)
                dialog = null
            }, { dialog = null })
            Dialog.Forget -> ForgetDialog(model.savedServer?.name ?: "这台电脑", {
                dialog = null
                model.forget()
            }, { dialog = null })
            null -> Unit
        }
    }
}
