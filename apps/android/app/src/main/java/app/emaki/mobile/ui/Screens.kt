package app.emaki.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.emaki.mobile.core.Addresses
import app.emaki.mobile.core.Hello
import app.emaki.mobile.core.HostPort
import app.emaki.mobile.core.PairAttempt
import app.emaki.mobile.core.SavedServer
import app.emaki.mobile.platform.FoundServer
import kotlinx.coroutines.delay
import java.time.Instant

// ---------------------------------------------------------------- 找电脑

@Composable
fun FindScreen(
    found: List<FoundServer>,
    deviceName: String,
    onPick: (FoundServer) -> Unit,
    onScan: () -> Unit,
    onManual: () -> Unit,
    onEditName: () -> Unit,
) {
    val p = LocalPaper.current
    // 搜了一会儿还没找到，提示退路
    var waitedLong by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(6_000)
        waitedLong = true
    }
    PaperPage(title = "连接到电脑", subtitle = "找同一个 Wi-Fi 里开着「手机访问」的 Emaki", tag = "page:find") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("局域网里的电脑", color = p.fg, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            if (found.isEmpty() || !waitedLong) Spinner(14.dp)
        }
        Spacer(Modifier.height(10.dp))
        if (found.isEmpty()) {
            Muted(
                if (waitedLong) "还没找到。电脑上要先打开 设置 →「手机访问」；路由器开了 AP 隔离、连的是访客 Wi-Fi 时也搜不到，可以扫码或手动输入地址。"
                else "正在找…",
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (s in found) ChoiceRow(Glyphs.Monitor, s.name, s.address.toString(), { onPick(s) }, tag = "server:${s.serverId}")
            }
        }

        Spacer(Modifier.height(22.dp))
        HairLine()
        Spacer(Modifier.height(16.dp))
        Text("找不到的话", color = p.fg, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(10.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            ChoiceRow(Glyphs.ScanQr, "扫码", "电脑上 设置 →「手机访问」→「用二维码添加」", onScan, tag = "find:scan")
            ChoiceRow(Glyphs.Keyboard, "手动输入地址", "例如 192.168.1.5:5175", onManual, tag = "find:manual")
        }

        Spacer(Modifier.height(20.dp))
        DeviceNameLine(deviceName, onEditName)
    }
}

/** 「这台手机在电脑上叫：Pixel 7  修改」 */
@Composable
fun DeviceNameLine(deviceName: String, onEditName: () -> Unit) {
    val p = LocalPaper.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Glyphs.Smartphone, null, Modifier.size(16.dp), tint = p.fgMuted)
        Spacer(Modifier.size(8.dp))
        Text("这台手机在电脑上叫「$deviceName」", color = p.fgMuted, fontSize = 13.sp, modifier = Modifier.weight(1f))
        GhostButton("修改", onEditName, color = p.fg)
    }
}

// ---------------------------------------------------------------- 正在连接

@Composable
fun BusyScreen(title: String, message: String, onCancel: (() -> Unit)? = null) {
    PaperPage(title = title, tag = "page:busy") {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 10.dp)) {
            Spinner()
            Spacer(Modifier.size(10.dp))
            Text(message, color = LocalPaper.current.fgMuted, fontSize = 14.sp, modifier = Modifier.testTag("busy"))
        }
        if (onCancel != null) {
            Spacer(Modifier.height(8.dp))
            GhostButton("取消", onCancel)
        }
    }
}

// ---------------------------------------------------------------- 请求连接

@Composable
fun RequestScreen(hello: Hello, address: HostPort, deviceName: String, onName: (String) -> Unit, onRequest: () -> Unit, onBack: () -> Unit) {
    val p = LocalPaper.current
    var name by rememberSaveable { mutableStateOf(deviceName) }
    PaperPage(title = "连接到电脑", subtitle = "「${hello.name}」上的 Emaki · $address", tag = "page:request") {
        OutlinedTextField(
            value = name,
            onValueChange = { if (it.length <= 60) name = it },
            label = { Text("设备名称") },
            leadingIcon = { Icon(Glyphs.Smartphone, null, Modifier.size(18.dp)) },
            singleLine = true,
            colors = textFieldColors(),
            shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().testTag("field:deviceName"),
        )
        Muted("电脑上会用这个名字列出这台手机，以后也能在电脑上改。", Modifier.padding(top = 6.dp), 12.5f)
        Spacer(Modifier.height(22.dp))
        PrimaryButton("请求连接", {
            onName(name)
            onRequest()
        }, enabled = hello.pairing && name.isNotBlank())
        Spacer(Modifier.height(12.dp))
        Text(
            if (hello.pairing) "电脑上会弹出提示。两边显示的校验码一样，再在电脑上点「批准」。" else "电脑现在不接受新的请求。",
            color = p.fgSubtle,
            fontSize = 12.5.sp,
            lineHeight = 19.sp,
        )
        Spacer(Modifier.height(8.dp))
        GhostButton("换一台电脑", onBack)
    }
}

// ---------------------------------------------------------------- 等批准

@Composable
fun WaitingScreen(serverName: String, attempt: PairAttempt, onCancel: () -> Unit) {
    val p = LocalPaper.current
    val expires = remember(attempt.expiresAt) { runCatching { Instant.parse(attempt.expiresAt).toEpochMilli() }.getOrNull() }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(attempt.id) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    PaperPage(title = "核对校验码", subtitle = "「$serverName」上的 Emaki", tag = "page:waiting") {
        Muted("校验码")
        CodeView(attempt.code, Modifier.padding(top = 4.dp))
        Spacer(Modifier.height(16.dp))
        Text("在电脑上核对数字一样后点「批准」", color = p.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Muted("数字不一样的话点「拒绝」：可能有别人在冒充这台手机。", Modifier.padding(top = 4.dp), 12.5f)
        Spacer(Modifier.height(22.dp))
        HairLine()
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 12.dp)) {
            Spinner(14.dp, p.fgSubtle)
            Spacer(Modifier.size(8.dp))
            val left = expires?.let { it - now }
            Text(
                "等电脑批准" + (if (left != null && left > 0) " · 还剩 ${countdown(left)}" else ""),
                color = p.fgSubtle,
                fontSize = 12.5.sp,
                modifier = Modifier.weight(1f),
            )
            GhostButton("取消", onCancel)
        }
    }
}

private fun countdown(ms: Long): String {
    val s = (ms + 999) / 1000
    return "%d:%02d".format(s / 60, s % 60)
}

// ---------------------------------------------------------------- 连不上、被移除、要更新、证书不对、失败

@Composable
fun OfflineScreen(
    server: SavedServer,
    certMismatch: HostPort?,
    note: String?,
    trying: Boolean,
    onRetry: () -> Unit,
    onChangeAddress: () -> Unit,
    onForget: () -> Unit,
) {
    PaperPage(title = "电脑不在线", subtitle = "「${server.name}」", tag = "page:offline") {
        // 在前台时一直在自动重连（ConnectionWatch）：电脑回来了（换了地址也行）自己回到主界面
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 14.dp).testTag("offline:auto")) {
            Spinner(14.dp)
            Spacer(Modifier.size(10.dp))
            Text(
                if (trying) "正在自动重连：正在找「${server.name}」…" else "正在自动重连：每隔几秒试一次，电脑回来了会自己接上",
                color = LocalPaper.current.fgMuted,
                fontSize = 13.sp,
                lineHeight = 19.sp,
            )
        }
        Row(verticalAlignment = Alignment.Top) {
            Icon(Glyphs.WifiOff, null, Modifier.size(20.dp).padding(top = 2.dp), tint = LocalPaper.current.fgMuted)
            Spacer(Modifier.size(10.dp))
            Text(
                "没连上「${server.name}」。看看电脑开着、Emaki 在运行、设置里的「手机访问」开着，手机和电脑在同一个网络里。",
                color = LocalPaper.current.fg,
                fontSize = 14.sp,
                lineHeight = 22.sp,
            )
        }
        Muted("上次连上的地址：${server.lastAddress}", Modifier.padding(top = 10.dp), 12.5f)
        if (note != null) Notice(note, modifier = Modifier.padding(top = 12.dp))
        if (certMismatch != null) {
            Notice("$certMismatch 上有一台设备的证书和这台电脑的对不上，没有连它。", danger = true, modifier = Modifier.padding(top = 12.dp))
        }
        Spacer(Modifier.height(22.dp))
        PrimaryButton("重试", onRetry, loading = trying, icon = Glyphs.Rotate)
        Spacer(Modifier.height(10.dp))
        SecondaryButton("换地址", onChangeAddress, Modifier.fillMaxWidth(), icon = Glyphs.Keyboard)
        Spacer(Modifier.height(6.dp))
        GhostButton("忘记这台电脑", onForget)
    }
}

@Composable
fun RemovedScreen(server: SavedServer, revoked: Boolean, onRequestAgain: () -> Unit, onForget: () -> Unit) {
    PaperPage(title = if (revoked) "已被电脑移除" else "电脑不认这台手机了", subtitle = "「${server.name}」", tag = "page:removed") {
        Notice(
            if (revoked) "这台手机已被电脑移除。要继续用，请重新请求连接，再到电脑上批准。"
            else "电脑上找不到这台手机的记录（可能重装过 Emaki 或换了图库）。要继续用，请重新请求连接，再到电脑上批准。",
        )
        Spacer(Modifier.height(22.dp))
        PrimaryButton("重新请求连接", onRequestAgain)
        Spacer(Modifier.height(6.dp))
        GhostButton("连接别的电脑", onForget)
    }
}

@Composable
fun UpgradeScreen(minAppVersion: String, appVersion: String, onRetry: () -> Unit, onForget: (() -> Unit)?) {
    PaperPage(title = "需要更新 App", tag = "page:upgrade") {
        Row(verticalAlignment = Alignment.Top) {
            Icon(Glyphs.ArrowUpCircle, null, Modifier.size(20.dp).padding(top = 2.dp), tint = LocalPaper.current.fgMuted)
            Spacer(Modifier.size(10.dp))
            Text(
                "电脑上的 Emaki 需要 App $minAppVersion 以上，这个 App 是 $appVersion。请先装上新版本的 Emaki App 再连接。",
                color = LocalPaper.current.fg,
                fontSize = 14.sp,
                lineHeight = 22.sp,
            )
        }
        Spacer(Modifier.height(22.dp))
        PrimaryButton("重试", onRetry, icon = Glyphs.Rotate)
        if (onForget != null) {
            Spacer(Modifier.height(6.dp))
            GhostButton("忘记这台电脑", onForget)
        }
    }
}

@Composable
fun CertWrongScreen(server: SavedServer?, address: HostPort, onRetry: () -> Unit, onForget: () -> Unit) {
    val name = server?.name?.let { "「$it」" } ?: "这台电脑"
    PaperPage(title = "证书不对", subtitle = address.toString(), tag = "page:cert") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Glyphs.ShieldAlert, null, Modifier.size(20.dp), tint = LocalPaper.current.danger)
            Spacer(Modifier.size(8.dp))
            Text("证书不对，可能有人冒充$name", color = LocalPaper.current.danger, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
        Muted(
            "$address 上的设备给出的证书，和${if (server != null) "配对时记下" else "二维码里"}的不一样，所以没有连接。" +
                "如果你在电脑上重装过 Emaki、换过数据目录（证书会重新生成），忘记这台电脑后重新请求连接就好。",
            Modifier.padding(top = 10.dp),
            13.5f,
        )
        Spacer(Modifier.height(22.dp))
        PrimaryButton("重试", onRetry, icon = Glyphs.Rotate)
        Spacer(Modifier.height(6.dp))
        GhostButton("忘记这台电脑", onForget)
    }
}

@Composable
fun FailedScreen(title: String, message: String, onRetry: (() -> Unit)?, onBack: () -> Unit) {
    PaperPage(title = title, tag = "page:failed") {
        Text(message, color = LocalPaper.current.fg, fontSize = 14.sp, lineHeight = 22.sp, modifier = Modifier.testTag("message"))
        Spacer(Modifier.height(22.dp))
        if (onRetry != null) {
            PrimaryButton("重试", onRetry, icon = Glyphs.Rotate)
            Spacer(Modifier.height(6.dp))
        }
        GhostButton("返回", onBack)
    }
}

// ---------------------------------------------------------------- 对话框

/** 手动输入地址：`主机:端口`，端口默认 5175 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun AddressDialog(title: String, initial: String, onSubmit: (HostPort) -> Unit, onDismiss: () -> Unit) {
    val p = LocalPaper.current
    var text by rememberSaveable { mutableStateOf(initial) }
    var tried by remember { mutableStateOf(false) }
    val parsed = Addresses.parse(text)
    val submit = {
        tried = true
        parsed?.let(onSubmit)
        Unit
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.raised,
        title = { Text(title, fontFamily = SerifCjk, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.semantics { testTagsAsResourceId = true }) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.trim() },
                    label = { Text("主机:端口") },
                    placeholder = { Text("192.168.1.5:5175") },
                    singleLine = true,
                    isError = tried && parsed == null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { submit() }),
                    colors = textFieldColors(),
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().testTag("field:address"),
                )
                Muted(
                    if (tried && parsed == null) "地址要写成 主机:端口，例如 192.168.1.5:5175"
                    else "端口不写就是 5175。电脑上 设置 →「手机访问」里能看到这台电脑的地址和端口。",
                    Modifier.padding(top = 8.dp),
                    12.5f,
                )
            }
        },
        confirmButton = { GhostButton("连接", submit, color = p.fg) },
        dismissButton = { GhostButton("取消", onDismiss) },
    )
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun DeviceNameDialog(initial: String, onSubmit: (String) -> Unit, onDismiss: () -> Unit) {
    val p = LocalPaper.current
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.raised,
        title = { Text("设备名称", fontFamily = SerifCjk, fontWeight = FontWeight.SemiBold) },
        text = {
            Column(Modifier.semantics { testTagsAsResourceId = true }) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { if (it.length <= 60) text = it },
                    singleLine = true,
                    colors = textFieldColors(),
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().testTag("field:name"),
                )
                Muted("电脑上会用这个名字列出这台手机。", Modifier.padding(top = 8.dp), 12.5f)
            }
        },
        confirmButton = { GhostButton("好", { onSubmit(text) }, color = p.fg) },
        dismissButton = { GhostButton("取消", onDismiss) },
    )
}

@Composable
fun ForgetDialog(name: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val p = LocalPaper.current
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.raised,
        title = { Text("忘记「$name」？", fontFamily = SerifCjk, fontWeight = FontWeight.SemiBold) },
        text = { Text("这台手机上的凭证会删掉，以后要重新请求连接、在电脑上批准。电脑上的设备记录不受影响，可以在电脑上移除。", fontSize = 14.sp, lineHeight = 22.sp) },
        confirmButton = { GhostButton("忘记", onConfirm, color = p.danger) },
        dismissButton = { GhostButton("取消", onDismiss) },
    )
}
