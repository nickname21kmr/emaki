package app.emaki.mobile.platform

import android.os.Build

/** 这台手机在电脑上显示的样子 */
object DeviceInfo {
    /** 默认的设备名称：型号（可改） */
    val defaultName: String get() = Build.MODEL?.trim().orEmpty().ifEmpty { "安卓手机" }

    /** 「Google Pixel 7 · Android 14」：厂商 型号 · Android 版本 */
    val model: String
        get() {
            val maker = Build.MANUFACTURER?.trim().orEmpty().replaceFirstChar { it.uppercase() }
            val model = Build.MODEL?.trim().orEmpty()
            val both = when {
                maker.isEmpty() -> model
                model.startsWith(maker, ignoreCase = true) -> model
                else -> "$maker $model"
            }
            return "$both · Android ${Build.VERSION.RELEASE}"
        }
}
