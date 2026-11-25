# Emaki 安卓 App

手机上的 Emaki：Kotlin 写的外壳，主界面是系统 WebView，加载电脑上 Emaki 提供的网页。原生部分只做这几件事：
在局域网里找电脑、请求连接（6 位校验码）、保存凭证、认准电脑的证书、之后每次打开自动连上、被电脑移除时回到原生页面。
设计见 [docs/mobile.md](../../docs/mobile.md) 第 2、3 节；配对协议见 `apps/server/src/access/pairing.ts` 的文件头。

- applicationId `app.emaki.mobile`，版本 0.5.0（versionCode 8），Android 10 以上（minSdk 29），targetSdk 35。
- 装好的 APK 在 [Releases](https://github.com/zhaochengggg/emaki/releases) 下载（用下面「签名密钥」里那把密钥签的）；也可以自己构建。
- 依赖：Compose（Material 3）、OkHttp、zxing-android-embedded（扫码，不依赖 Google Play 服务）。没有统计、推送、广告。
- 这个目录没有 package.json，npm 的 workspaces 不会管它。

## 代码在哪

| 目录 | 做什么 |
| --- | --- |
| `app/src/main/java/app/emaki/mobile/core/` | 纯 Kotlin，不碰安卓 API（单元测试都在这一层）：校验码和 commit（`Crypto.kt`）、只认指纹的 TrustManager（`Pinning.kt`）、地址解析和候选顺序（`Addresses.kt`）、二维码（`PairTicket.kt`）、`/api/v1` 的 JSON（`Protocol.kt`）、原生请求（`EmakiApi.kt`）、配对流程（`Pairing.kt`）、无感重连（`Reconnect.kt`）、保存（`ServerStore.kt`） |
| `.../platform/` | 安卓的部分：NsdManager 找电脑（`Discovery.kt`）、Keystore 加密凭证（`Storage.kt`）、设备名称和型号 |
| `.../ui/` | 原生页面（Compose）和 WebView 主界面（`WebScreen.kt`） |
| `.../AppModel.kt` | 页面之间怎么走（找电脑 → 请求 → 等批准 → 主界面；电脑不在线、已被电脑移除、需要更新、证书不对） |
| `.../ConnectionWatch.kt` | 断线处理（docs/mobile.md 3.6）：主界面上核实连接（`core/Liveness.kt` 的 `LinkCheck`），「电脑不在线」页面上自动重连 |
| `.../core/Uploads.kt` | 传图（docs/mobile.md 5.4）：算 sha256、先问电脑有没有、分段传、断点续传、同时传 2 个、限速 4 MiB/s（`Uploader`、`RateLimiter`），照 `apps/server/scripts/lan-client.ts` 的 upload 写 |
| `.../platform/UploadWork.kt` | 「传到电脑」→「选图片」选的图排成后台任务（WorkManager）：前台服务通知进度，连不上电脑过一会儿重试，传完通知结果 |
| `.../ShareActivity.kt` | 「分享到 Emaki」：别的 App 分享过来的图拷进这一批的临时目录，排进后台上传（和「选图片」一样），没有界面 |
| `.../core/AlbumSync.kt` | 同步相册（docs/mobile.md 5.5）的规则：盘点（每个相册电脑上有几张、老图在哪）、同步（只传电脑上没有的、删过的不传），和安卓无关，有单元测试 |
| `.../platform/MediaIndex.kt`、`SyncDb.kt`、`AlbumSyncWork.kt` | 读 MediaStore 的相册和图（要读照片的权限）、手机上记的 sha256 和处理过的、同步任务（只在 App 开着时：打开 App、开着时相册有新图、用户点的；关掉后正在传的传完） |

网页那边两处配合：`apps/web/src/lib/deviceAuth.ts` 在有 `window.EmakiApp` 时，遇到 401 调 `EmakiApp.unpaired(code)`，
不显示网页自己的「连接到电脑」页；`apps/web/src/lib/connection.ts` 连不上电脑时调 `EmakiApp.connectionLost()`，不显示网页自己的提示条；
图库页头的「传到电脑」图标（`features/gallery/components/SendToComputer.tsx`）在有 `EmakiApp.pickImages` 时显示；
有 `EmakiApp.syncAlbums`（0.3.0 起）时点开是一个面板：「选图片上传」+「同步相册」（`features/access/AlbumSync.tsx`），老版本直接打开选图界面。
插件对应的外部网站（docs/plugins.md 第 6 节 `site@1`，0.5.0 起）：网页在 App 里打开这种插件页面时调 `EmakiApp.openSite(插件, 网站)`，
App 打开 `SiteActivity`（站内浏览：网站本身加上插件的脚本，`core/SiteBridge.kt` 是和安卓无关的部分，有单元测试）。

## 构建

要 JDK 17 和 Android SDK 35（platform、build-tools 35）；Gradle 由 wrapper 下载（`gradle/wrapper`，带 sha256 校验），
依赖来自 Google Maven 和 Maven Central。机器配置低的话别在上面跑模拟器。

```bash
cd apps/android
./gradlew testDebugUnitTest                      # 单元测试（JVM，不要模拟器）
./gradlew assembleDebug                          # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease -Pemaki.signing=<signing.properties 的路径>
                                                 # app/build/outputs/apk/release/app-release.apk（已签名）
```

## 签名密钥

- release 用的密钥（`emaki-release.jks`，PKCS12，RSA 4096，有效期 100 年，别名 `emaki`）和 `signing.properties`
  （storeFile、storePassword、keyAlias、keyPassword）由发布 APK 的人保管，**不进仓库**（`.gitignore` 挡着 `*.jks`、`signing.properties`）。
- Releases 里的 APK 的证书指纹（SHA-256）：`69:98:B3:C8:F2:52:38:12:B2:9A:82:A5:AE:E2:5B:AC:54:F2:5F:E6:41:85:A0:89:60:8A:38:BA:9B:FF:D7:F3`。
  核对：`$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs app-release.apk`。
- 安卓只允许用同一把密钥签的新版本覆盖安装：换了密钥（自己构建的、别人发的）要先卸载，App 里保存的配对也跟着没了，重新请求连接一次就好。
- **要备份**：密钥丢了，以后的新版本就装不上（docs/mobile.md 3.4）。
- 没给 `-Pemaki.signing`（或环境变量 `EMAKI_SIGNING`）时 release 也能构建，只是没签名、装不上。

## 在真机上装

1. 把 APK 传到手机上直接点开安装（要允许「安装未知应用」）。或者用 adb：手机上打开「开发者选项」→「无线调试」，
   配对一次 `adb pair <手机 IP>:<配对端口>`（输手机上显示的配对码），再 `adb connect <手机 IP>:<端口>`、`adb install -r app-release.apk`。
2. debug 和 release 的签名不同，换着装要先 `adb uninstall app.emaki.mobile`。
3. 电脑上打开 Emaki 的 设置 →「手机访问」。手机连同一个 Wi-Fi，打开 App：列表里会出现这台电脑；点它，核对两边的校验码一样，在电脑上点「批准」。
   列表里没有（路由器开了 AP 隔离、访客 Wi-Fi）时用「扫码」或「手动输入地址」（`主机:端口`，端口默认 5175）。

## 模拟器端到端（无窗口运行，要 KVM）

```bash
avdmanager create avd -n emaki-a2 -k "system-images;android-35;google_apis;x86_64" -d pixel_4
emulator -avd emaki-a2 -no-window -no-audio -gpu swiftshader_indirect -no-snapshot &
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

模拟器在 NAT 后面，收不到局域网的 mDNS：「自动发现」只能在真机上测，模拟器里用「手动输入地址」。
扫码的流程可以用 `adb shell am start -a android.intent.action.VIEW -d '<电脑上生成的 emaki://pair?… 链接>'` 代替相机。
断线处理（docs/mobile.md 3.6）可以这样测：在电脑上用 `PATCH /api/access {"enabled":false}` 关掉局域网入口、再 `{"enabled":true}` 打开（证书、设备都不变），
或者在模拟器里 `adb shell svc wifi disable` / `svc data disable` 断网；`adb logcat -s Emaki` 能看到「网页报连不上」「换了网络」「自动重连：连上了」。
debug 版可以用 Chrome 的 devtools 看 WebView：`adb forward tcp:9333 localabstract:webview_devtools_remote_<App 的 pid>`。
