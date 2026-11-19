package app.emaki.mobile.platform

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.emaki.mobile.BuildConfig
import app.emaki.mobile.MainActivity
import app.emaki.mobile.R
import app.emaki.mobile.core.ApiException
import app.emaki.mobile.core.EmakiApi
import app.emaki.mobile.core.ReconnectResult
import app.emaki.mobile.core.Reconnector
import app.emaki.mobile.core.UploadFile
import app.emaki.mobile.core.UploadProgress
import app.emaki.mobile.core.Uploader
import org.json.JSONArray
import java.io.File
import java.io.IOException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * 手动上传（B1，docs/mobile.md 5.4）：网页上点「从手机添加」→ 系统选图界面 → 这里排一个后台任务（WorkManager）传给电脑。
 *
 * - 选的图的地址（content://）写进 files/uploads/<批次>.json（WorkManager 的参数放不下几百个地址），能拿长期读权限的拿上；
 * - 任务在前台服务里跑（通知栏显示「正在传到 <电脑>：3 / 10」），App 退到后台、锁屏也接着传；
 * - 先找到电脑（上次的地址、局域网里按标识找、hello 给过的其他地址，和打开 App 时一样），连不上就过一会儿重试（退避，最长 5 小时）；
 *   传了一半断了也是重试：已经传完的电脑直接回「传过了」，传了一半的从断点接着传；
 * - 传完一条通知「已传 8 张，2 张电脑上本来就有」；设备被电脑移除了就停下，通知说明。
 */
object UploadQueue {
    private const val DIR = "uploads"
    const val KEY_BATCH = "batch"

    private fun listFile(context: Context, batchId: String) = File(File(context.filesDir, DIR).apply { mkdirs() }, "$batchId.json")

    /** 排一批；返回批次 id */
    fun enqueue(context: Context, uris: List<Uri>): String {
        val batchId = UUID.randomUUID().toString()
        for (u in uris) runCatching { context.contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        listFile(context, batchId).writeText(JSONArray(uris.map { it.toString() }).toString())
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(workDataOf(KEY_BATCH to batchId))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .addTag(TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("upload-$batchId", ExistingWorkPolicy.KEEP, request)
        return batchId
    }

    fun uris(context: Context, batchId: String): List<Uri> {
        val f = listFile(context, batchId)
        if (!f.exists()) return emptyList()
        val a = JSONArray(f.readText())
        return List(a.length()) { Uri.parse(a.getString(it)) }
    }

    fun forget(context: Context, batchId: String) {
        val uris = uris(context, batchId)
        for (u in uris) runCatching { context.contentResolver.releasePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        listFile(context, batchId).delete()
    }

    const val TAG = "upload"
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val notifications = NotificationManagerCompat.from(context)
    private val notificationId = (params.id.hashCode() and 0x7fffffff) or 1

    override suspend fun doWork(): Result {
        val batchId = inputData.getString(UploadQueue.KEY_BATCH) ?: return Result.failure()
        val uris = UploadQueue.uris(applicationContext, batchId)
        if (uris.isEmpty()) return Result.success()
        val saved = serverStore(applicationContext).load() ?: return finish(batchId, "没有连接过电脑，传不了")
        setForeground(foreground(saved.name, UploadProgress(0, uris.size, null)))

        val reconnector = Reconnector(BuildConfig.VERSION_NAME)
        val address = when (val r = reconnector.run(saved) { Discovery(applicationContext).find(saved.serverId) }) {
            is ReconnectResult.Online -> r.address
            is ReconnectResult.Removed -> return finish(batchId, "这台设备已经被电脑移除，图没有传")
            is ReconnectResult.Upgrade -> return finish(batchId, "电脑上的 Emaki 要求先更新 App，图没有传")
            // 电脑关着、不在同一个网络：过一会儿再试
            is ReconnectResult.Offline -> return retryOrGiveUp(batchId, saved.name)
        }
        val files = uris.mapNotNull { fileOf(it) }
        val uploader = Uploader(EmakiApi(address, saved.fingerprintBytes).uploads(saved.token))
        return try {
            val summary = uploader.run(batchId, files) { p -> runCatching { setForegroundAsync(foreground(saved.name, p)) } }
            val unreadable = uris.size - files.size
            finish(batchId, summary.text() + (if (unreadable > 0) "，$unreadable 张在手机上读不到" else ""))
        } catch (e: ApiException) {
            if (e.unauthorized) finish(batchId, "这台设备已经被电脑移除，图没有传完") else retryOrGiveUp(batchId, saved.name)
        } catch (e: IOException) {
            retryOrGiveUp(batchId, saved.name)
        }
    }

    /** 网络问题：重试（WorkManager 退避）；试了很多次还不行就放弃，通知说明 */
    private fun retryOrGiveUp(batchId: String, computer: String): Result =
        if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else finish(batchId, "一直连不上「$computer」，图没有传完，可以回到电脑旁边再传一次")

    /** 这一批结束了（传完了，或者传不了）：清掉选图记录，通知结果。不再重试 */
    private fun finish(batchId: String, text: String): Result {
        UploadQueue.forget(applicationContext, batchId)
        notify(notificationId + 1, done(text))
        return Result.success()
    }

    /** 手机上的一个图：名字、大小、拍摄 / 修改时间；读不到的跳过 */
    private fun fileOf(uri: Uri): UploadFile? {
        val resolver = applicationContext.contentResolver
        var name: String? = null
        var size: Long? = null
        var takenMs: Long? = null
        runCatching {
            resolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { name = c.getString(it) }
                    c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
                    c.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN).takeIf { it >= 0 && !c.isNull(it) }?.let { takenMs = c.getLong(it) }
                    if (takenMs == null || takenMs == 0L)
                        c.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED).takeIf { it >= 0 && !c.isNull(it) }?.let { takenMs = c.getLong(it) * 1000 }
                }
            }
        }
        val bytes = size ?: runCatching { resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } }.getOrNull()?.takeIf { it > 0 } ?: return null
        val open = { resolver.openInputStream(uri) ?: throw IOException("手机上读不到这张图") }
        if (runCatching { open().close() }.isFailure) return null
        return UploadFile(
            name = name ?: "image.jpg",
            size = bytes,
            modifiedAt = takenMs?.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() },
            open = open,
        )
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foreground(null, UploadProgress(0, 0, null))

    private fun foreground(computer: String?, p: UploadProgress): ForegroundInfo {
        channel()
        val text = if (p.total > 0) "${p.done} / ${p.total}" + (p.current?.let { " · $it" } ?: "") else "准备中"
        val n = NotificationCompat.Builder(applicationContext, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (computer != null) "正在传到「$computer」" else "正在传图")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(p.total, p.done, p.total == 0)
            .setContentIntent(openApp())
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(notificationId, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(notificationId, n)
    }

    private fun done(text: String) = NotificationCompat.Builder(applicationContext, CHANNEL.also { channel() })
        .setSmallIcon(R.drawable.ic_notify)
        .setContentTitle("传图")
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setAutoCancel(true)
        .setContentIntent(openApp())
        .build()

    private fun openApp() = android.app.PendingIntent.getActivity(
        applicationContext,
        0,
        Intent(applicationContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        android.app.PendingIntent.FLAG_IMMUTABLE,
    )

    private fun notify(id: Int, n: android.app.Notification) {
        val allowed = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (allowed) runCatching { notifications.notify(id, n) }
    }

    private fun channel() {
        val nm = applicationContext.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "传图", NotificationManager.IMPORTANCE_LOW).apply { description = "把手机上的图传到电脑的进度" })
    }

    companion object {
        const val CHANNEL = "uploads"
        /** 大约 30 秒、1、2、4 分钟……试 8 次（加起来两个多小时）还连不上就放弃 */
        const val MAX_ATTEMPTS = 8
    }
}
