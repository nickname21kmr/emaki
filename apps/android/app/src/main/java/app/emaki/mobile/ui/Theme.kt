package app.emaki.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * 「私人画集」的颜色（docs/FRONTEND.md 设计语言，取自 apps/web/src/styles/index.css 的米纸底色）：
 * 纸、墨、一方朱印。朱色只用来做「印」（徽记、校验码旁的小印），主按钮是墨色。深浅跟随系统。
 */
@Immutable
data class Paper(
    val dark: Boolean,
    /** 画卷外的桌面（页面底） */
    val canvas: Color,
    /** 主内容区的纸 */
    val sheet: Color,
    /** 卡片 */
    val raised: Color,
    /** 输入框、次级面 */
    val sunken: Color,
    val line: Color,
    val lineStrong: Color,
    /** 章节细线、双线 */
    val rule: Color,
    val fg: Color,
    val fgMuted: Color,
    val fgSubtle: Color,
    val fgInverse: Color,
    /** 墨：主按钮 */
    val ink: Color,
    /** 朱：印 */
    val shu: Color,
    val brand: Color,
    val warn: Color,
    val warnSoft: Color,
    val danger: Color,
    val dangerSoft: Color,
)

val LightPaper = Paper(
    dark = false,
    canvas = Color(0xFFECE8E0),
    sheet = Color(0xFFFAF8F4),
    raised = Color(0xFFFFFEFB),
    sunken = Color(0xFFEDE9E2),
    line = Color(0x17281E14),
    lineStrong = Color(0x29281E14),
    rule = Color(0x38281E14),
    fg = Color(0xFF1C1A17),
    fgMuted = Color(0xFF6B655B),
    fgSubtle = Color(0xFFA0998D),
    fgInverse = Color(0xFFFBFAF8),
    ink = Color(0xFF1F1D19),
    shu = Color(0xFFD9442A),
    brand = Color(0xFFC73A27),
    warn = Color(0xFFC77D12),
    warnSoft = Color(0xFFFBEFD9),
    danger = Color(0xFFCF3030),
    dangerSoft = Color(0xFFFBE3E1),
)

val DarkPaper = Paper(
    dark = true,
    canvas = Color(0xFF0D0C0B),
    sheet = Color(0xFF161412),
    raised = Color(0xFF1E1B18),
    sunken = Color(0xFF12100E),
    line = Color(0x14FFF4E4),
    lineStrong = Color(0x26FFF4E4),
    rule = Color(0x33FFF4E4),
    fg = Color(0xFFECE6DC),
    fgMuted = Color(0xFFA39A8E),
    fgSubtle = Color(0xFF6F675D),
    fgInverse = Color(0xFF161412),
    ink = Color(0xFFECE6DC),
    shu = Color(0xFFEE6242),
    brand = Color(0xFFEE6242),
    warn = Color(0xFFF0A83A),
    warnSoft = Color(0x24F0A83A),
    danger = Color(0xFFFF5F5F),
    dangerSoft = Color(0x24FF5F5F),
)

val LocalPaper = staticCompositionLocalOf { LightPaper }

/** 中文衬线（页面大标题、kicker）：系统的衬线字体，中文是思源宋体 / Noto Serif CJK */
val SerifCjk = FontFamily.Serif

@Composable
fun EmakiTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val p = if (dark) DarkPaper else LightPaper
    val scheme = if (dark) {
        darkColorScheme(
            primary = p.ink, onPrimary = p.fgInverse, secondary = p.shu, onSecondary = p.fgInverse,
            background = p.canvas, onBackground = p.fg, surface = p.sheet, onSurface = p.fg,
            surfaceVariant = p.sunken, onSurfaceVariant = p.fgMuted, surfaceContainerHigh = p.raised,
            surfaceContainerHighest = p.raised, surfaceContainer = p.raised,
            outline = p.lineStrong, outlineVariant = p.line, error = p.danger, onError = p.fgInverse,
        )
    } else {
        lightColorScheme(
            primary = p.ink, onPrimary = p.fgInverse, secondary = p.shu, onSecondary = p.fgInverse,
            background = p.canvas, onBackground = p.fg, surface = p.sheet, onSurface = p.fg,
            surfaceVariant = p.sunken, onSurfaceVariant = p.fgMuted, surfaceContainerHigh = p.raised,
            surfaceContainerHighest = p.raised, surfaceContainer = p.raised,
            outline = p.lineStrong, outlineVariant = p.line, error = p.danger, onError = p.fgInverse,
        )
    }
    val base = Typography()
    val body = TextStyle(fontSize = 15.sp, lineHeight = 23.sp, letterSpacing = 0.sp)
    val typography = base.copy(
        bodyLarge = base.bodyLarge.merge(body),
        bodyMedium = base.bodyMedium.merge(TextStyle(fontSize = 14.sp, lineHeight = 21.sp, letterSpacing = 0.sp)),
        bodySmall = base.bodySmall.merge(TextStyle(fontSize = 12.5.sp, lineHeight = 19.sp, letterSpacing = 0.sp)),
        labelLarge = base.labelLarge.merge(TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp)),
        titleMedium = base.titleMedium.merge(TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp)),
    )
    CompositionLocalProvider(LocalPaper provides p) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}

/** 页面大标题：中文衬线、字距 0.04em */
val DisplayTitle = TextStyle(fontFamily = SerifCjk, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 36.sp, letterSpacing = 0.04.em)

/** kicker：小号衬线、加字距 */
val Kicker = TextStyle(fontFamily = SerifCjk, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.12.em)

/** 校验码：等宽、加粗、字距 0.08em */
val CodeStyle = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, fontSize = 46.sp, lineHeight = 52.sp, letterSpacing = 0.08.em)
