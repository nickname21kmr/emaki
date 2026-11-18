# Emaki 安卓 App

手机上的 Emaki：Kotlin 写的外壳，主界面是系统 WebView，加载电脑上 Emaki 提供的网页。原生部分只做这几件事：
在局域网里找电脑、请求连接（6 位校验码）、保存凭证、认准电脑的证书、之后每次打开自动连上、被电脑移除时回到原生页面。
设计见 [docs/mobile.md](../../docs/mobile.md) 第 2、3 节；配对协议见 `apps/server/src/access/pairing.ts` 的文件头。

- applicationId `app.emaki.mobile`，版本 0.1.0（versionCode 1），Android 10 以上（minSdk 29），targetSdk 35。
- 依赖：Compose（Material 3）、OkHttp、zxing-android-embedded（扫码，不依赖 Google Play 服务）。没有统计、推送、广告。
- 这个目录没有 package.json，npm 的 workspaces 不会管它。

## 代码在哪

| 目录 | 做什么 |
| --- | --- |
| `app/src/main/java/app/emaki/mobile/core/` | 纯 Kotlin，不碰安卓 API（单元测试都在这一层）：校验码和 commit（`Crypto.kt`）、只认指纹的 TrustManager（`Pinning.kt`）、地址解析和候选顺序（`Addresses.kt`）、二维码（`PairTicket.kt`）、`/api/v1` 的 JSON（`Protocol.kt`）、原生请求（`EmakiApi.kt`）、配对流程（`Pairing.kt`）、无感重连（`Reconnect.kt`）、保存（`ServerStore.kt`） |
| `.../platform/` | 安卓的部分：NsdManager 找电脑（`Discovery.kt`）、Keystore 加密凭证（`Storage.kt`）、设备名称和型号 |
| `.../ui/` | 原生页面（Compose）和 WebView 主界面（`WebScreen.kt`） |
| `.../AppModel.kt` | 页面之间怎么走（找电脑 → 请求 → 等批准 → 主界面；电脑不在线、已被电脑移除、需要更新、证书不对） |

网页那边只有一处配合：`apps/web/src/lib/deviceAuth.ts` 在有 `window.EmakiApp` 时，遇到 401 调 `EmakiApp.unpaired(code)`，
不显示网页自己的「连接到电脑」页。

## 在哪构建

在 **x99e** 上构建（`ssh x99`，32 核，有 KVM）。开发机（2 核 2 GB）不要跑 Gradle、模拟器。

```bash
# 把这个目录同步过去（build 产物不带）
rsync -az --delete --exclude .gradle --exclude build --exclude app/build --exclude .kotlin --exclude emulator.log \
  apps/android/ x99:/root/emaki-dev/app/

ssh x99
source /root/emaki-dev/android/env.sh                      # JDK 17、Android SDK 35、build-tools 35、emulator、adb
export GRADLE_USER_HOME=/root/emaki-dev/android/gradle-home  # Gradle 的缓存也放在 /root/emaki-dev/android 下
cd /root/emaki-dev/app
./gradlew testDebugUnitTest                      # 单元测试（JVM，不要模拟器）
./gradlew assembleDebug                          # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease -Pemaki.signing=/root/emaki-dev/android/keys/signing.properties
                                                 # app/build/outputs/apk/release/app-release.apk（已签名）
```

x99e 能直连 Google Maven、Maven Central、services.gradle.org；Gradle 本身由 wrapper 下载（`gradle/wrapper`，带 sha256 校验）。

## 签名密钥

- release 用的密钥在 x99e 的 **`/root/emaki-dev/android/keys/`**：`emaki-release.jks`（PKCS12，RSA 4096，有效期 100 年，别名 `emaki`）
  和 `signing.properties`（storeFile、storePassword、keyAlias、keyPassword）。两个文件都是 600 权限，**不进仓库**（`.gitignore` 挡着 `*.jks`、`signing.properties`）。
- 证书指纹（SHA-256）：`69:98:B3:C8:F2:52:38:12:B2:9A:82:A5:AE:E2:5B:AC:54:F2:5F:E6:41:85:A0:89:60:8A:38:BA:9B:FF:D7:F3`。
  核对一个 APK 是不是用这把密钥签的：`$ANDROID_HOME/build-tools/35.0.0/apksigner verify --print-certs app-release.apk`。
- **要备份**：密钥丢了，以后的新版本就装不上，只能卸载重装（App 里保存的配对也跟着没了）。把整个目录拷一份到电脑上，例如
  `scp -r x99:/root/emaki-dev/android/keys <电脑上的备份目录>`，和 `signing.properties` 里的密码一起放在只有自己能看的地方（docs/mobile.md 3.4）。
- 没给 `-Pemaki.signing`（或环境变量 `EMAKI_SIGNING`）时 release 也能构建，只是没签名、装不上。

## 在真机上装

1. 手机上打开「开发者选项」→「无线调试」，在 x99e 上配对一次：`adb pair <手机 IP>:<配对端口>`（输手机上显示的配对码），再 `adb connect <手机 IP>:<端口>`。
   或者把 APK 传到手机上直接点开安装（要允许「安装未知应用」）。
2. `adb install -r app-release.apk`。debug 和 release 的签名不同，换着装要先 `adb uninstall app.emaki.mobile`。
3. 电脑上打开 Emaki 的 设置 →「手机访问」。手机连同一个 Wi-Fi，打开 App：列表里会出现这台电脑；点它，核对两边的校验码一样，在电脑上点「批准」。
   列表里没有（路由器开了 AP 隔离、访客 Wi-Fi）时用「扫码」或「手动输入地址」（`主机:端口`，端口默认 5175）。

## 模拟器端到端（x99e 上无窗口运行）

```bash
avdmanager create avd -n emaki-a2 -k "system-images;android-35;google_apis;x86_64" -d pixel_4
emulator -avd emaki-a2 -no-window -no-audio -gpu swiftshader_indirect -no-snapshot &
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

模拟器在 NAT 后面，收不到局域网的 mDNS：「自动发现」只能在真机上测，模拟器里用「手动输入地址」。
扫码的流程可以用 `adb shell am start -a android.intent.action.VIEW -d '<电脑上生成的 emaki://pair?… 链接>'` 代替相机。
debug 版可以用 Chrome 的 devtools 看 WebView：`adb forward tcp:9333 localabstract:webview_devtools_remote_<App 的 pid>`。
