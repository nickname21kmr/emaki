package app.emaki.mobile

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import app.emaki.mobile.platform.UploadQueue
import app.emaki.mobile.platform.serverStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 「分享到 Emaki」（docs/mobile.md 5.4）：在别的 App（浏览器、相册……）里用系统的「分享」把图发给 Emaki，传到电脑。
 * 没有界面：分享给的读权限只在这一会儿有效（后台任务里就读不到了），所以先把图拷进这一批的临时目录，
 * 再排进后台上传（和「传到电脑」→「选图片」一样：先问电脑有没有、断点续传、通知栏显示进度、传完删掉临时文件），弹一句提示就关掉。
 * 还没连接过电脑时提示先打开 Emaki 连上。
 */
class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uris = sharedUris(intent)
        val saved = serverStore(applicationContext).load()
        when {
            uris.isEmpty() -> done("没有收到图片")
            saved == null -> done("还没连接电脑：先打开 Emaki 连上电脑，再分享")
            else -> lifecycleScope.launch {
                val batchId = UploadQueue.newBatchId()
                val dir = UploadQueue.workDir(applicationContext, batchId)
                val copied = withContext(Dispatchers.IO) { uris.mapIndexedNotNull { i, u -> copy(u, File(dir, "share/$i")) } }
                if (copied.isEmpty()) done("读不到分享过来的图")
                else {
                    UploadQueue.enqueue(applicationContext, copied.map { Uri.fromFile(it) }, batchId)
                    done("开始传 ${copied.size} 张到「${saved.name}」，进度在通知栏")
                }
            }
        }
    }

    private fun done(text: String) {
        Toast.makeText(applicationContext, text, Toast.LENGTH_SHORT).show()
        finish()
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(i: Intent): List<Uri> {
        val stream: List<Uri> = when (i.action) {
            Intent.ACTION_SEND -> listOfNotNull(
                if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableExtra(Intent.EXTRA_STREAM),
            )
            Intent.ACTION_SEND_MULTIPLE ->
                (if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableArrayListExtra(Intent.EXTRA_STREAM))
                    ?.filterNotNull() ?: emptyList()
            else -> emptyList()
        }
        if (stream.isNotEmpty()) return stream
        // 有的 App 只放在 ClipData 里
        val clip = i.clipData ?: return emptyList()
        return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    }

    /** 拷一张到 dir：保留文件名和修改时间（入库后的文件照它）；读不到返回 null */
    private fun copy(uri: Uri, dir: File): File? = runCatching {
        var name: String? = null
        var modifiedMs: Long? = null
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) }
                c.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN).takeIf { it >= 0 && !c.isNull(it) }?.let { modifiedMs = c.getLong(it) }
                if (modifiedMs == null || modifiedMs == 0L)
                    c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED).takeIf { it >= 0 && !c.isNull(it) }?.let { modifiedMs = c.getLong(it) * 1000 }
            }
        }
        val safe = (name ?: uri.lastPathSegment ?: "image.jpg").substringAfterLast('/').replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "image.jpg" }
        val out = File(dir.apply { mkdirs() }, safe)
        val input = contentResolver.openInputStream(uri) ?: return@runCatching null
        input.use { src -> out.outputStream().use { src.copyTo(it) } }
        modifiedMs?.takeIf { it > 0 }?.let { out.setLastModified(it) }
        out.takeIf { it.length() > 0 }
    }.getOrNull()
}
