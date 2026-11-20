package app.emaki.mobile.platform

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
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
import app.emaki.mobile.core.AlbumConfig
import app.emaki.mobile.core.AlbumReport
import app.emaki.mobile.core.AlbumSyncState
import app.emaki.mobile.core.AlbumSyncer
import app.emaki.mobile.core.ApiException
import app.emaki.mobile.core.EmakiApi
import app.emaki.mobile.core.ReconnectResult
import app.emaki.mobile.core.Reconnector
import app.emaki.mobile.core.SyncProgress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * 同步相册的任务（B2，docs/mobile.md 5.5），规则在 core/AlbumSync.kt。
 *
 * 只在 App 开着时同步（用户 2026-11-20：App 关着不用一直同步）：
 * - 打开 App、回到 App（syncSoon）；
 * - App 开着时相册有新图：MainActivity 监听媒体库，10 秒内没有新变化就同步（syncSoon）；
 * - 用户在「同步相册」里点「盘点相册」「现在同步」、改了设置（runNow）。
 * 关掉 App 时正在传的会传完（前台服务，通知栏显示进度），但不会自己开始新的。没有定时任务、内容触发
 * （0.3.0、0.3.1 安排过的，打开 App 时撤掉：cancelLegacy）。
 * 「只在 Wi-Fi」照电脑上的设置；同一时间只跑一个（进程内的锁）。电脑上把这台设备移除了、App 忘掉了这台电脑：全部停掉。
 */
object AlbumSync {
    const val KEY_MODE = "mode"
    const val INVENTORY = "inventory"
    const val SYNC = "sync"
    private const val NOW = "album-sync-now"
    private const val OPEN = "album-sync-open"
    /** 0.3.0、0.3.1 的后台同步（内容触发、每 4 小时） */
    private val LEGACY = listOf("album-sync-trigger", "album-sync-periodic")

    private fun prefs(context: Context) = context.getSharedPreferences("album-sync", Context.MODE_PRIVATE)

    private fun request(mode: String, wifiOnly: Boolean) = OneTimeWorkRequestBuilder<AlbumSyncWorker>()
        .setInputData(workDataOf(KEY_MODE to mode))
        .setConstraints(Constraints.Builder().setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        .build()

    /** 这台手机的随机标识：批次 id 用它区分设备（同一天同一个相册进同一批） */
    fun installId(context: Context): String {
        val p = prefs(context)
        return p.getString("installId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("installId", it).apply() }
    }

    /** 有在同步的相册（上次同步时电脑说的）：App 才需要监听媒体库 */
    fun syncing(context: Context): Boolean = prefs(context).getBoolean("syncing", false)

    /** 用户点的：马上跑（只要有网）；连着点的排在后面 */
    fun runNow(context: Context, mode: String) {
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, request(mode, wifiOnly = false))
    }

    /** 打开 App、App 开着时相册有新图：有在同步的相册就同步一次（照「只在 Wi-Fi」）；正在同步的排在它后面 */
    fun syncSoon(context: Context) {
        val p = prefs(context)
        if (!p.getBoolean("syncing", false) || !MediaIndex.canRead(context)) return
        WorkManager.getInstance(context)
            .enqueueUniqueWork(OPEN, ExistingWorkPolicy.APPEND_OR_REPLACE, request(SYNC, p.getBoolean("wifiOnly", true)))
    }

    /** 每次跑完记下电脑的设置：有没有在同步的相册、只在 Wi-Fi */
    fun remember(context: Context, config: AlbumConfig) {
        prefs(context).edit().putBoolean("syncing", config.syncing.isNotEmpty()).putBoolean("wifiOnly", config.wifiOnly).apply()
    }

    /** 0.3.0、0.3.1 安排过的后台同步撤掉（App 关着时不再同步） */
    fun cancelLegacy(context: Context) {
        val wm = WorkManager.getInstance(context)
        for (name in LEGACY) wm.cancelUniqueWork(name)
    }

    /** 设备被电脑移除了、忘掉了这台电脑：全部停掉 */
    fun stop(context: Context) {
        prefs(context).edit().putBoolean("syncing", false).apply()
        val wm = WorkManager.getInstance(context)
        for (name in listOf(NOW, OPEN) + LEGACY) wm.cancelUniqueWork(name)
    }
}

class AlbumSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private var lastNotice = 0L

    override suspend fun doWork(): Result = lock.withLock { withContext(Dispatchers.IO) { work() } }

    private suspend fun work(): Result {
        val ctx = applicationContext
        val mode = inputData.getString(AlbumSync.KEY_MODE) ?: AlbumSync.SYNC
        val saved = serverStore(ctx).load() ?: return Result.success()
        val address = when (val r = Reconnector(BuildConfig.VERSION_NAME).run(saved) { Discovery(ctx).find(saved.serverId) }) {
            is ReconnectResult.Online -> r.address
            is ReconnectResult.Removed -> {
                AlbumSync.stop(ctx)
                return Result.success()
            }
            is ReconnectResult.Upgrade -> return Result.success()
            // 电脑关着、不在同一个网络：过一会儿再试
            is ReconnectResult.Offline -> return if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
        }
        val api = EmakiApi(address, saved.fingerprintBytes)
        val albums = api.albums(saved.token)
        if (!MediaIndex.canRead(ctx)) {
            val error = if (MediaIndex.partial(ctx)) "只允许了读部分照片，相册里的新图看不到：在 Emaki 的「同步相册」里点「盘点相册」，选「允许访问全部」"
            else "没有读照片的权限：在 Emaki 的「同步相册」里点「盘点相册」，选「允许访问全部」"
            runCatching { albums.report(AlbumReport(emptyList(), full = false, state = AlbumSyncState(null, error = error))) }
            return Result.success()
        }
        val db = SyncDb(ctx)
        return try {
            db.forServer(saved.serverId)
            val installId = AlbumSync.installId(ctx)
            val day = LocalDate.now().toString()
            val syncer = AlbumSyncer(
                uploads = api.uploads(saved.token),
                albums = albums,
                store = db,
                reader = { MediaIndex.open(ctx, it) },
                batchIdOf = { album -> UUID.nameUUIDFromBytes("$installId|$album|$day".toByteArray()).toString() },
            )
            val items = MediaIndex.images(ctx)
            if (mode == AlbumSync.INVENTORY) {
                foreground(saved.name, "正在盘点相册", SyncProgress("hash", 0, items.size, null))
                val config = syncer.inventory(items) { p -> progressNotice(saved.name, "正在盘点相册", p) }
                AlbumSync.remember(ctx, config)
                done("相册盘点完了", "回到 Emaki 的「同步相册」看看建议同步哪些相册")
            } else {
                var foregrounded = false
                val result = syncer.sync(items) { p ->
                    if (p.phase != "upload") return@sync
                    // 有图要传了才进前台（通知栏显示进度，关掉 App 也传完）；起不了前台服务就算了，照样传
                    if (!foregrounded) {
                        foregrounded = true
                        foreground(saved.name, "正在同步相册", p)
                    } else progressNotice(saved.name, "正在同步相册", p)
                }
                AlbumSync.remember(ctx, result.config)
                if (result.imported > 0 || result.failed.isNotEmpty()) done("同步相册", "${result.text()}（「${saved.name}」）")
            }
            Result.success()
        } catch (e: ApiException) {
            Log.w(TAG, "同步相册（$mode）：电脑回了 ${e.status} ${e.code}", e)
            when {
                e.unauthorized -> {
                    AlbumSync.stop(ctx)
                    done("同步相册", "这台设备已经被电脑移除，相册不再同步")
                    Result.success()
                }
                e.status >= 500 && runAttemptCount < MAX_ATTEMPTS -> Result.retry()
                else -> {
                    runCatching { albums.report(AlbumReport(emptyList(), full = false, state = AlbumSyncState(null, error = e.message))) }
                    Result.success()
                }
            }
        } catch (e: IOException) {
            // 断网、电脑关了、读到一半的文件没了……过一会儿重试（做完的都记下了）
            Log.w(TAG, "同步相册（$mode）第 ${runAttemptCount + 1} 次：${e.javaClass.simpleName}: ${e.message}", e)
            if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
        } finally {
            db.close()
            // 没进成前台时发的进度通知是常驻的：跑完收掉
            runCatching { androidx.core.app.NotificationManagerCompat.from(ctx).cancel(NOTICE_ID) }
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = info(null, "正在同步相册", SyncProgress("hash", 0, 0, null))

    private suspend fun foreground(computer: String, title: String, p: SyncProgress) {
        try {
            setForeground(info(computer, title, p))
        } catch (e: Exception) {
            // Android 12+ 后台起不了前台服务（内容触发、定时的）：照样跑，只是没有进度通知（最多 10 分钟，没做完的下次接着）
        }
    }

    private fun progressNotice(computer: String, title: String, p: SyncProgress) {
        val t = System.currentTimeMillis()
        if (t - lastNotice < 1000 && p.done < p.total) return
        lastNotice = t
        notifyIfAllowed(applicationContext, NOTICE_ID, notification(computer, title, p))
    }

    private fun info(computer: String?, title: String, p: SyncProgress): ForegroundInfo {
        val n = notification(computer, title, p)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ForegroundInfo(NOTICE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTICE_ID, n)
    }

    private fun notification(computer: String?, title: String, p: SyncProgress): android.app.Notification {
        ensureUploadChannel(applicationContext)
        val what = if (p.phase == "hash") "读图" else "传到「${computer ?: "电脑"}」"
        val text = if (p.total > 0) "$what：${p.done} / ${p.total}" else "准备中"
        return NotificationCompat.Builder(applicationContext, UploadWorker.CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setProgress(p.total, p.done, p.total == 0)
            .setContentIntent(openApp())
            .build()
    }

    private fun done(title: String, text: String) {
        ensureUploadChannel(applicationContext)
        val n = NotificationCompat.Builder(applicationContext, UploadWorker.CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()
        notifyIfAllowed(applicationContext, DONE_ID, n)
    }

    private fun openApp() = android.app.PendingIntent.getActivity(
        applicationContext,
        0,
        Intent(applicationContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        android.app.PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        private const val TAG = "AlbumSync"
        private val lock = Mutex()
        const val MAX_ATTEMPTS = 6
        private const val NOTICE_ID = 0x51A0
        private const val DONE_ID = 0x51A1
    }
}
