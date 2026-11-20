package app.emaki.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.emaki.mobile.core.PairCrypto

/**
 * 原生页面的骨架，照网页的「连接到电脑」页（apps/web/src/features/access/PairingPage.tsx）：
 * 桌面色的底上一张纸；页头 = kicker（徽记 + Emaki + 小题）+ 衬线大标题 + 副标题 + 双线。
 */
@Composable
fun PaperPage(
    title: String,
    subtitle: String? = null,
    kicker: String = "手机访问",
    tag: String = "page",
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalPaper.current
    Box(
        Modifier
            .fillMaxSize()
            .background(p.canvas)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 20.dp),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier
                .widthIn(max = 440.dp)
                .fillMaxWidth()
                .shadow(elevation = 10.dp, shape = RoundedCornerShape(20.dp), ambientColor = Color(0x33281E14), spotColor = Color(0x33281E14))
                .clip(RoundedCornerShape(20.dp))
                .background(p.sheet)
                .testTag(tag),
        ) {
            Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 26.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Emblem(14.dp, p.brand)
                    Spacer(Modifier.size(8.dp))
                    Text("Emaki", color = p.brand, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, style = Kicker)
                    Spacer(Modifier.size(12.dp))
                    Text(kicker, color = p.fgMuted, style = Kicker)
                }
                Text(title, style = DisplayTitle, color = p.fg, modifier = Modifier.padding(top = 10.dp).testTag("title"))
                if (subtitle != null) {
                    Text(subtitle, fontSize = 13.sp, lineHeight = 19.sp, color = p.fgMuted, modifier = Modifier.padding(top = 6.dp))
                }
                DoubleRule(Modifier.padding(top = 18.dp))
            }
            Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 26.dp), content = content)
        }
    }
}

/** 双线（rule-double）：上一道 rule、下一道 line，间隔 2dp */
@Composable
fun DoubleRule(modifier: Modifier = Modifier) {
    val p = LocalPaper.current
    Column(modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.rule))
        Spacer(Modifier.height(2.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
    }
}

@Composable
fun HairLine(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(LocalPaper.current.line))
}

private val Pill = RoundedCornerShape(percent = 50)

/** 主按钮：墨色胶囊 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
) {
    val p = LocalPaper.current
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        shape = Pill,
        colors = ButtonDefaults.buttonColors(
            containerColor = p.ink,
            contentColor = p.fgInverse,
            disabledContainerColor = p.ink.copy(alpha = 0.35f),
            disabledContentColor = p.fgInverse.copy(alpha = 0.8f),
        ),
        contentPadding = PaddingValues(horizontal = 20.dp),
        modifier = modifier.fillMaxWidth().heightIn(min = 50.dp).testTag("btn:$text"),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(16.dp), color = p.fgInverse, strokeWidth = 2.dp)
            Spacer(Modifier.size(10.dp))
        } else if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
        }
        Text(text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** 次按钮：纸面胶囊，细边 */
@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val p = LocalPaper.current
    OutlinedButton(
        onClick = onClick,
        shape = Pill,
        colors = ButtonDefaults.outlinedButtonColors(containerColor = p.raised, contentColor = p.fg),
        border = androidx.compose.foundation.BorderStroke(1.dp, p.lineStrong),
        contentPadding = PaddingValues(horizontal = 18.dp),
        modifier = modifier.heightIn(min = 46.dp).testTag("btn:$text"),
    ) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp))
            Spacer(Modifier.size(8.dp))
        }
        Text(text, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
    }
}

/** 文字按钮（取消、忘记这台电脑） */
@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = LocalPaper.current.fgMuted) {
    TextButton(onClick = onClick, shape = Pill, modifier = modifier.testTag("btn:$text")) {
        Text(text, color = color, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

/** 提示条：warn 是黄底（被移除了），danger 是红底（证书不对） */
@Composable
fun Notice(text: String, modifier: Modifier = Modifier, danger: Boolean = false) {
    val p = LocalPaper.current
    Text(
        text,
        color = if (danger) p.danger else p.warn,
        fontSize = 13.5.sp,
        lineHeight = 21.sp,
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (danger) p.dangerSoft else p.warnSoft)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    )
}

@Composable
fun Muted(text: String, modifier: Modifier = Modifier, size: Float = 13f) {
    Text(text, color = LocalPaper.current.fgMuted, fontSize = size.sp, lineHeight = (size * 1.6f).sp, modifier = modifier)
}

@Composable
fun Spinner(size: Dp = 16.dp, color: Color = LocalPaper.current.fgMuted) {
    CircularProgressIndicator(Modifier.size(size), color = color, strokeWidth = 2.dp)
}

/** 大号校验码，3 + 3 分组 */
@Composable
fun CodeView(code: String, modifier: Modifier = Modifier) {
    Text(
        PairCrypto.group(code),
        style = CodeStyle,
        color = LocalPaper.current.fg,
        modifier = modifier.testTag("code").semantics { contentDescription = "校验码 ${code.toList().joinToString(" ")}" },
    )
}

/** 一行可点的条目：图标 + 标题 + 副标题 + 右箭头 */
@Composable
fun ChoiceRow(icon: ImageVector, title: String, detail: String?, onClick: () -> Unit, tag: String = "row:$title") {
    val p = LocalPaper.current
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(1.dp, p.line, RoundedCornerShape(12.dp))
            .background(p.raised)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, Modifier.size(22.dp), tint = p.fg)
        Column(Modifier.weight(1f)) {
            Text(title, color = p.fg, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail != null) Text(detail, color = p.fgMuted, fontSize = 12.5.sp, lineHeight = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Icon(Glyphs.ChevronRight, null, Modifier.size(18.dp), tint = p.fgSubtle)
    }
}

@Composable
fun textFieldColors() = LocalPaper.current.let { p ->
    OutlinedTextFieldDefaults.colors(
        focusedBorderColor = p.shu,
        unfocusedBorderColor = p.lineStrong,
        focusedContainerColor = p.sunken,
        unfocusedContainerColor = p.sunken,
        cursorColor = p.shu,
        focusedLabelColor = p.fgMuted,
        unfocusedLabelColor = p.fgMuted,
    )
}
