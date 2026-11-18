package app.emaki.mobile.platform

import android.content.Context
import android.os.Build
import android.provider.Settings

/** 这台手机在电脑上显示的样子 */
object DeviceInfo {
    /**
     * 默认的设备名称（可改）：系统设置里「设备名称」那一项（小米平板上是「Xiaomi Pad 6 Pro」，用户改过就是改过的名字），
     * 没有再用型号（Build.MODEL 常常是「23046RP50C」这种型号代码，电脑上认不出是哪台）
     */
    fun defaultName(context: Context): String {
        val system = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        return system?.trim().orEmpty().ifEmpty { Build.MODEL?.trim().orEmpty() }.ifEmpty { "安卓手机" }
    }

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
