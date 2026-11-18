package app.emaki.mobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** 几个线条图标（取自网页用的 lucide，24 × 24、线宽 2），不引入整套图标库 */
object Glyphs {
    private fun lucide(name: String, vararg paths: String): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            for (d in paths) {
                addPath(
                    pathData = addPathNodes(d),
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val Monitor = lucide("monitor", "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4")
    val ScanQr = lucide(
        "scan-qr",
        "M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2",
        "M8 7h3v3H8z", "M13 14h3v3h-3z", "M13 7h3", "M8 14v3", "M16 10v1",
    )
    val Keyboard = lucide(
        "keyboard",
        "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
        "M6 8h.01", "M10 8h.01", "M14 8h.01", "M18 8h.01", "M8 12h.01", "M12 12h.01", "M16 12h.01", "M7 16h10",
    )
    val Smartphone = lucide("smartphone", "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M12 18h.01")
    val Rotate = lucide("rotate-cw", "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5")
    val ChevronRight = lucide("chevron-right", "m9 18 6-6-6-6")
    val ShieldAlert = lucide(
        "shield-alert",
        "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        "M12 8v4", "M12 16h.01",
    )
    val WifiOff = lucide(
        "wifi-off",
        "M12 20h.01", "M8.5 16.429a5 5 0 0 1 7 0", "M5 12.859a10 10 0 0 1 5.17-2.69", "M19 12.859a10 10 0 0 0-2.007-1.523",
        "M2 8.82a15 15 0 0 1 4.177-2.643", "M22 8.82a15 15 0 0 0-11.288-3.764", "m2 2 20 20",
    )
    val Pencil = lucide(
        "pencil",
        "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
        "m15 5 4 4",
    )
    val ArrowUpCircle = lucide("circle-arrow-up", "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z", "m16 12-4-4-4 4", "M12 16V8")
}

/**
 * 徽记「相角徽环」（apps/web/public/favicon.svg，和 App 图标同一个）：圆环 + 四向相角刻度 + 中间一张照片。
 * 64 × 64 的设计稿按 size 缩放。
 */
@Composable
fun Emblem(size: Dp, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val k = this.size.minDimension / 64f
        drawCircle(color, radius = 21f * k, center = Offset(32f * k, 32f * k), style = Stroke(width = 6f * k))
        val tri = Path().apply {
            fun t(ax: Float, ay: Float, bx: Float, by: Float, cx: Float, cy: Float) {
                moveTo(ax * k, ay * k); lineTo(bx * k, by * k); lineTo(cx * k, cy * k); close()
            }
            t(32f, 2f, 39f, 10f, 25f, 10f)
            t(32f, 62f, 39f, 54f, 25f, 54f)
            t(2f, 32f, 10f, 25f, 10f, 39f)
            t(62f, 32f, 54f, 25f, 54f, 39f)
        }
        drawPath(tri, color)
        drawPath(tri, color, style = Stroke(width = 1f * k, join = StrokeJoin.Round))
        drawRoundRect(
            color,
            topLeft = Offset(23.5f * k, 21f * k),
            size = Size(17f * k, 22f * k),
            cornerRadius = CornerRadius(2.5f * k),
            style = Stroke(width = 5f * k),
        )
    }
}
