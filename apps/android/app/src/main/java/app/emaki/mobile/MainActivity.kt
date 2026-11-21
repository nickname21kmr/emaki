package app.emaki.mobile

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
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
import app.emaki.mobile.platform.AlbumSync
import app.emaki.mobile.platform.FoundServer
import app.emaki.mobile.platform.MediaIndex
import app.emaki.mobile.platform.UploadQueue
import app.emaki.mobile.ui.AlbumSyncRequest
import app.emaki.mobile.ui.AddressDialog
import app.emaki.mobile.ui.BusyScreen
import app.emaki.mobile.ui.CertWrongScreen
import app.emaki.mobile.ui.DeviceNameDialog
import app.emaki.mobile.ui.EmakiTheme
import app.emaki.mobile.ui.FailedScreen
import app.emaki.mobile.ui.FileChooser
import app.emaki.mobile.ui.FindScreen
import app.emaki.mobile.ui.ImagePicker
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

    /** 「传到电脑」→「选图片」：系统的选图界面（Android Photo Picker，可多选，不用存储权限），选完排进后台上传 */
    private val pickImages = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        if (uris.isEmpty()) return@registerForActivityResult
        UploadQueue.enqueue(this, uris)
        Toast.makeText(this, "开始传 ${uris.size} 张，进度在通知栏", Toast.LENGTH_SHORT).show()
    }

    /** 第一次传图、同步相册前问一下通知权限（Android 13+）：给不给都照样做，只是看不到进度 */
    private var afterNotifications: (() -> Unit)? = null
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        afterNotifications?.invoke()
        afterNotifications = null
    }

    private fun withNotifications(then: () -> Unit) {
        val prefs = getSharedPreferences("ui", MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs.getBoolean("askedNotifications", false)
        ) {
            prefs.edit().putBoolean("askedNotifications", true).apply()
            afterNotifications = then
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            then()
        }
    }

    /**
     * 有读照片的权限（打开过同步相册）：系统的选图界面，原来的文件名按编号查得到（UploadWork 的 contentFile）；
     * 没有：系统的文件选择器，它给的就是原来的文件名（选图界面不给，Pixiv 这类来源就认不出了）
     */
    private fun launchPicker() {
        if (MediaIndex.canRead(this)) pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        else pickDocuments.launch(arrayOf("image/*"))
    }

    private val pickDocuments = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@registerForActivityResult
        UploadQueue.enqueue(this, uris)
        Toast.makeText(this, "开始传 ${uris.size} 张，进度在通知栏", Toast.LENGTH_SHORT).show()
    }

    private val imagePicker = ImagePicker { withNotifications(::launchPicker) }

    /**
     * 「同步相册」（docs/mobile.md 5.5）：要读所有照片的权限。只允许了「部分照片」、或者拒绝过不再弹框的，带去系统设置里改
     */
    private var pendingAlbumMode = AlbumSync.INVENTORY
    private val askMedia = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
        when {
            MediaIndex.canRead(this) -> startAlbumSync(pendingAlbumMode)
            MediaIndex.partial(this) -> {
                Toast.makeText(this, "同步相册要读所有照片：在「照片和视频」里选「允许访问全部」", Toast.LENGTH_LONG).show()
                openAppSettings()
            }
            else -> {
                val asked = MediaIndex.permissions().first()
                if (!shouldShowRequestPermissionRationale(asked)) openAppSettings()
                Toast.makeText(this, "没有读照片的权限，同步不了相册", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startAlbumSync(mode: String) {
        AlbumSync.runNow(this, mode)
        watchMedia(true)
        Toast.makeText(this, if (mode == AlbumSync.INVENTORY) "开始盘点相册，进度在通知栏" else "开始同步相册", Toast.LENGTH_SHORT).show()
    }

    private val albumSync = AlbumSyncRequest { mode ->
        withNotifications {
            if (MediaIndex.canRead(this)) startAlbumSync(mode)
            else {
                pendingAlbumMode = mode
                askMedia.launch(MediaIndex.permissions())
            }
        }
    }

    private fun openAppSettings() {
        runCatching {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
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
        // 只在 App 开着时同步相册：老版本安排过的后台同步撤掉
        AlbumSync.cancelLegacy(this)
        setContent {
            EmakiTheme {
                App(model, fileChooser, imagePicker, albumSync, ::setBarIcons)
            }
        }
    }

    // 在前台时才探（docs/mobile.md 3.6）：回到前台核实一次连接，「电脑不在线」页面上自动重连；到后台就停，省电
    override fun onResume() {
        super.onResume()
        model.foreground(true)
        watchNetwork(true)
        // 打开、回到 App 时同步一次相册（有在同步的相册才会）；开着时相册有新图也同步
        AlbumSync.syncSoon(this)
        watchMedia(true)
    }

    override fun onPause() {
        watchMedia(false)
        watchNetwork(false)
        model.foreground(false)
        super.onPause()
    }

    /**
     * App 开着时相册有新图（分屏下载、截图、别的 App 存的）：10 秒内没有新变化就同步一次（docs/mobile.md 5.5）。
     * 到后台就不听了：App 关着不同步
     */
    private val mediaHandler = Handler(Looper.getMainLooper())
    private val syncAfterQuiet = Runnable { AlbumSync.syncSoon(this) }
    private val mediaObserver = object : ContentObserver(mediaHandler) {
        override fun onChange(selfChange: Boolean) {
            mediaHandler.removeCallbacks(syncAfterQuiet)
            mediaHandler.postDelayed(syncAfterQuiet, MEDIA_QUIET_MS)
        }
    }
    private var watchingMedia = false

    private fun watchMedia(on: Boolean) {
        if (on && !watchingMedia && MediaIndex.canRead(this)) {
            runCatching { contentResolver.registerContentObserver(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true, mediaObserver) }
                .onSuccess { watchingMedia = true }
        } else if (!on && watchingMedia) {
            runCatching { contentResolver.unregisterContentObserver(mediaObserver) }
            mediaHandler.removeCallbacks(syncAfterQuiet)
            watchingMedia = false
        }
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

    private companion object {
        const val MEDIA_QUIET_MS = 10_000L
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
private fun App(
    model: AppModel,
    fileChooser: FileChooser,
    imagePicker: ImagePicker,
    albumSync: AlbumSyncRequest,
    setBarIcons: (Boolean) -> Unit,
) {
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
                imagePicker = imagePicker,
                albumSync = albumSync,
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
