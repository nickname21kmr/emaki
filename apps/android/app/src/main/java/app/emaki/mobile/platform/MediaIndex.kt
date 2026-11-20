package app.emaki.mobile.platform

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import app.emaki.mobile.core.AlbumSyncer
import app.emaki.mobile.core.MediaItem
import java.io.FileNotFoundException
import java.io.InputStream

/**
 * 手机上的图（MediaStore，docs/mobile.md 5.5）：一个相册 = 一个文件夹（RELATIVE_PATH）。
 * 要「照片和视频」的权限（Android 13+ 是 READ_MEDIA_IMAGES；只允许了「部分照片」的看不到新图，同步不了）。
 * 有「读取照片位置」（ACCESS_MEDIA_LOCATION）时读原文件（setRequireOriginal）：不然系统会抹掉照片里的位置，
 * 读出来的内容和电脑上拷过去的那份不一样，sha256 对不上，会被当成新图再传一份。
 */
object MediaIndex {
    private val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI

    /**
     * 要申请的权限（第一个是读照片的）。Android 14+ 一起申请「部分照片」：用户选了部分时 READ_MEDIA_IMAGES 是拒绝的，
     * 能看出来（不然系统会临时给全部，盘点只看得到选的那几张）
     */
    fun permissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.ACCESS_MEDIA_LOCATION)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION)
    }

    /** 能读所有的图 */
    fun canRead(context: Context): Boolean {
        val p = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        return context.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    }

    /** 只允许了「部分照片」（Android 14+） */
    fun partial(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 34 && !canRead(context) &&
            context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED

    private fun original(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** 所有相册里的图（不含还没写完的、回收站里的：MediaStore 默认就不给） */
    fun images(context: Context): List<MediaItem> {
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.RELATIVE_PATH,
            MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.DATE_TAKEN,
        )
        val out = ArrayList<MediaItem>()
        context.contentResolver.query(uri, projection, null, null, null)?.use { c ->
            val id = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val rel = c.getColumnIndexOrThrow(MediaStore.MediaColumns.RELATIVE_PATH)
            val bucket = c.getColumnIndexOrThrow(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)
            val name = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val size = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val modified = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
            val taken = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_TAKEN)
            while (c.moveToNext()) {
                val album = AlbumSyncer.albumPath(c.getString(rel)) ?: continue
                val bytes = if (c.isNull(size)) 0L else c.getLong(size)
                if (bytes <= 0) continue
                val modifiedSec = if (c.isNull(modified)) 0L else c.getLong(modified)
                val takenMs = if (c.isNull(taken)) 0L else c.getLong(taken)
                out += MediaItem(
                    id = c.getLong(id),
                    album = album,
                    albumName = c.getString(bucket) ?: album.substringAfterLast('/'),
                    fileName = c.getString(name) ?: "image.jpg",
                    size = bytes,
                    modifiedSec = modifiedSec,
                    takenMs = takenMs.takeIf { it > 0 } ?: modifiedSec.takeIf { it > 0 }?.times(1000),
                )
            }
        }
        return out
    }

    fun open(context: Context, item: MediaItem): InputStream {
        var u = ContentUris.withAppendedId(uri, item.id)
        if (original(context)) u = MediaStore.setRequireOriginal(u)
        return context.contentResolver.openInputStream(u) ?: throw FileNotFoundException("手机上读不到「${item.fileName}」")
    }
}
