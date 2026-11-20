package app.emaki.mobile.platform

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
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
 * 同步相册的后台任务（B2，docs/mobile.md 5.5），规则在 core/AlbumSync.kt。
 *
 * 什么时候跑：
 * - 用户在「同步相册」里点「盘点相册」「现在同步」、改了设置（runNow，加急，只要有网）；
 * - 相册有变化（WorkManager 的内容触发：媒体库变了，1 分钟内没有新变化就跑，最多等 10 分钟）；
 * - 每 4 小时一次兜底（内容触发可能被系统省电吞掉），顺便拿电脑上改过的设置；
 * - 打开 App（kick）。
 * 后台的那几种照电脑上的设置：只在 Wi-Fi、只在充电时。同一时间只跑一个（进程内的锁）。
 * 电脑上把这台设备移除了：全部停掉。
 */
object AlbumSync {
    const val KEY_MODE = "mode"
    const val KEY_TRIGGER = "trigger"
    const val INVENTORY = "inventory"
    const val SYNC = "sync"
    private const val NOW = "album-sync-now"
    private const val OPEN = "album-sync-open"
    private const val TRIGGER = "album-sync-trigger"
    private const val PERIODIC = "album-sync-periodic"

    private fun prefs(context: Context) = context.getSharedPreferences("album-sync", Context.MODE_PRIVATE)

    private fun constraints(wifiOnly: Boolean, chargingOnly: Boolean, trigger: Boolean = false): Constraints =
        Constraints.Builder()
            .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresCharging(chargingOnly)
            .apply {
                if (trigger) {
                    addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
                    setTriggerContentUpdateDelay(1, TimeUnit.MINUTES)
                    setTriggerContentMaxDelay(10, TimeUnit.MINUTES)
                }
            }
            .build()

    /** 这台手机的随机标识：批次 id 用它区分设备（同一天同一个相册进同一批） */
    fun installId(context: Context): String {
        val p = prefs(context)
        return p.getString("installId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("installId", it).apply() }
    }

    /** 用户点的：马上跑（加急）；连着点的排在后面 */
    fun runNow(context: Context, mode: String) {
        val request = OneTimeWorkRequestBuilder<AlbumSyncWorker>()
            .setInputData(workDataOf(KEY_MODE to mode))
            .setConstraints(constraints(wifiOnly = false, chargingOnly = false))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    /** 打开 App：有在同步的相册就同步一次（照设置的条件） */
    fun kick(context: Context) {
        val p = prefs(context)
        if (!p.getBoolean("syncing", false) || !MediaIndex.canRead(context)) return
        val request = OneTimeWorkRequestBuilder<AlbumSyncWorker>()
            .setInputData(workDataOf(KEY_MODE to SYNC))
            .setConstraints(constraints(p.getBoolean("wifiOnly", true), p.getBoolean("chargingOnly", false)))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(OPEN, ExistingWorkPolicy.KEEP, request)
    }

    /**
     * 每次跑完按电脑的设置安排后台同步：兜底的定时任务；有在同步的相册时再加内容触发。
     * fromTrigger：是内容触发的那个任务自己在调（它还在跑，下一个排在它后面）
     */
    fun schedule(context: Context, config: AlbumConfig, fromTrigger: Boolean) {
        val p = prefs(context)
        val changed = !p.getBoolean("enabled", false) ||
            p.getBoolean("wifiOnly", true) != config.wifiOnly ||
            p.getBoolean("chargingOnly", false) != config.chargingOnly
        p.edit()
            .putBoolean("enabled", true)
            .putBoolean("syncing", config.syncing.isNotEmpty())
            .putBoolean("wifiOnly", config.wifiOnly)
            .putBoolean("chargingOnly", config.chargingOnly)
            .apply()
        val wm = WorkManager.getInstance(context)
        wm.enqueueUniquePeriodicWork(
            PERIODIC,
            if (changed) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<AlbumSyncWorker>(4, TimeUnit.HOURS)
                .setInputData(workDataOf(KEY_MODE to SYNC))
                .setConstraints(constraints(config.wifiOnly, config.chargingOnly))
                .build(),
        )
        if (config.syncing.isEmpty()) {
            if (!fromTrigger) wm.cancelUniqueWork(TRIGGER)
            return
        }
        val trigger = OneTimeWorkRequestBuilder<AlbumSyncWorker>()
            .setInputData(workDataOf(KEY_MODE to SYNC, KEY_TRIGGER to true))
            .setConstraints(constraints(config.wifiOnly, config.chargingOnly, trigger = true))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        val policy = when {
            fromTrigger -> ExistingWorkPolicy.APPEND_OR_REPLACE
            changed -> ExistingWorkPolicy.REPLACE
            else -> ExistingWorkPolicy.KEEP
        }
        wm.enqueueUniqueWork(TRIGGER, policy, trigger)
    }

    /** 设备被电脑移除了、忘掉了这台电脑：全部停掉 */
    fun stop(context: Context) {
        prefs(context).edit().putBoolean("enabled", false).putBoolean("syncing", false).apply()
        val wm = WorkManager.getInstance(context)
        for (name in listOf(NOW, OPEN, TRIGGER, PERIODIC)) wm.cancelUniqueWork(name)
    }
}

class AlbumSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private var lastNotice = 0L

    override suspend fun doWork(): Result = lock.withLock { withContext(Dispatchers.IO) { work() } }

    private suspend fun work(): Result {
        val ctx = applicationContext
        val mode = inputData.getString(AlbumSync.KEY_MODE) ?: AlbumSync.SYNC
        val fromTrigger = inputData.getBoolean(AlbumSync.KEY_TRIGGER, false)
        val saved = serverStore(ctx).load() ?: return Result.success()
        val address = when (val r = Reconnector(BuildConfig.VERSION_NAME).run(saved) { Discovery(ctx).find(saved.serverId) }) {
            is ReconnectResult.Online -> r.address
            is ReconnectResult.Removed -> {
                AlbumSync.stop(ctx)
                return Result.success()
            }
            is ReconnectResult.Upgrade -> return Result.success()
            // 电脑关着、不在同一个网络：过一会儿再试（后台的还有定时、内容触发兜着）
            is ReconnectResult.Offline -> return if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
        }
        val api = EmakiApi(address, saved.fingerprintBytes)
        val albums = api.albums(saved.token)
        if (!MediaIndex.canRead(ctx)) {
            val error = if (MediaIndex.partial(ctx)) "只允许了读部分照片，相册里的新图看不到：在 Emaki 的「同步相册」里点「盘点相册」，选「全部允许」"
            else "没有读照片的权限：在 Emaki 的「同步相册」里点「盘点相册」，允许读照片"
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
                AlbumSync.schedule(ctx, config, fromTrigger)
                done("相册盘点完了", "回到 Emaki 的「同步相册」看看建议同步哪些相册")
            } else {
                var foregrounded = false
                val result = syncer.sync(items) { p ->
                    if (p.phase != "upload") return@sync
                    // 有图要传了才进前台（通知栏显示进度）；后台起不了前台服务就算了，照样传
                    if (!foregrounded) {
                        foregrounded = true
                        foreground(saved.name, "正在同步相册", p)
                    } else progressNotice(saved.name, "正在同步相册", p)
                }
                AlbumSync.schedule(ctx, result.config, fromTrigger)
                if (result.imported > 0 || result.failed.isNotEmpty()) done("同步相册", "${result.text()}（「${saved.name}」）")
            }
            Result.success()
        } catch (e: ApiException) {
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
        private val lock = Mutex()
        const val MAX_ATTEMPTS = 6
        private const val NOTICE_ID = 0x51A0
        private const val DONE_ID = 0x51A1
    }
}
