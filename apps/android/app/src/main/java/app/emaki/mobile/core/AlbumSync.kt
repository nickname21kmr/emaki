package app.emaki.mobile.core

import kotlinx.coroutines.ensureActive
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.time.Instant
import kotlin.coroutines.coroutineContext

/**
 * 同步相册（B2，docs/mobile.md 5.5）的规则，和安卓无关（测试里换成假的相册、假的电脑）：
 *
 * - 一个相册 = 手机上的一个文件夹（MediaStore 的 RELATIVE_PATH，去掉两头的斜杠），不含子文件夹；
 * - 盘点（inventory）：读所有相册里的每张图算 sha256（算过的、大小和修改时间没变的不重算），问电脑有没有，按相册数出
 *   有 / 在「上传到」里 / 删过 / 没有，和老图最集中的文件夹，报给电脑；电脑据此建议同步哪些相册、新图放到哪；
 * - 同步（sync）：报相册清单、拿回要同步的相册 → 只看这些相册里没处理过的图（处理过 = 电脑上有了、删过的、传过的，
 *   记下当时的 sha256，内容变了就不算）→ 问电脑 → 有的、删过的记下不传，其余的按相册传（Uploader，clientKey = MediaStore 的 id）
 *   → 报结果（每个相册还有几张没传上来）。
 * - 网络问题（IOException）、设备被移除（401）原样抛出，交给调用方（WorkManager）重试或停下；做完的都记下了，重跑不会重复。
 * - 读不到的图（同步途中被删了、没权限）跳过，不算网络问题。
 * - HEIF（看文件头，改成 .jpg 的也算）电脑读不了：传之前在手机上转成 JPEG（一张一张转，转完就传，不占内存）。
 *   电脑上存的是转过的那份；手机上的原图不动。用户 2026-11-20 同意的（weibo 里存下来的是 HEIF）。
 * - 电脑读不了的（422，格式不支持）记成 rejected:<sha256>，转过 JPEG 还被拒的记成 rejected-jpeg:<sha256>，以后不再传；
 *   重新盘点时清掉，再试一次。以前（不会转的版本）记下的 HEIF 会转了再试。
 */

/** 相册里的一张图（MediaStore 的一行） */
data class MediaItem(
    val id: Long,
    /** 相册：手机上的文件夹路径，'Download'、'Pictures/bili' */
    val album: String,
    val albumName: String,
    val fileName: String,
    val size: Long,
    /** 修改时间（秒，DATE_MODIFIED）：和 size 一起判断算过的 sha256 还能不能用 */
    val modifiedSec: Long,
    /** 拍摄 / 修改时间（毫秒）：入库后的文件照它 */
    val takenMs: Long?,
)

/** 读手机上的图；测试里换成假的 */
fun interface MediaReader {
    fun open(item: MediaItem): InputStream

    /** 电脑读不了的格式（HEIF）转成 JPEG；转不了是 null */
    fun toJpeg(item: MediaItem): ByteArray? = null
}

/** App 本地记的：算过的 sha256（按 id + 大小 + 修改时间），处理过的（id → 当时的 sha256） */
interface SyncStore {
    fun cachedSha(id: Long, size: Long, modifiedSec: Long): String?
    fun putSha(id: Long, size: Long, modifiedSec: Long, sha256: String)
    fun handled(id: Long): String?
    fun markHandled(id: Long, sha256: String)
    fun clearHandled(id: Long)
    /** 手机上没有了的忘掉 */
    fun retain(ids: Set<Long>)
}

data class AlbumInventory(
    val total: Int,
    val have: Int,
    val inTarget: Int,
    val deleted: Int,
    val new: Int,
    val newBytes: Long,
    val folder: String?,
    val folderCount: Int,
)

data class ReportedAlbum(
    val path: String,
    val name: String,
    val count: Int,
    val bytes: Long,
    val latestAt: String?,
    val inventory: AlbumInventory? = null,
    /** 同步完还没传上来的（会再试） */
    val pending: Int? = null,
    /** 电脑读不了的（格式不支持）：不再传 */
    val rejected: Int? = null,
)

/** App 现在在做什么：running 是 inventory / sync / null（闲着） */
data class AlbumSyncState(
    val running: String?,
    val done: Int? = null,
    val total: Int? = null,
    val error: String? = null,
    val summary: String? = null,
)

/** POST /api/uploads/albums 的请求体：full = 这是手机上全部的相册 */
data class AlbumReport(val albums: List<ReportedAlbum>, val full: Boolean, val state: AlbumSyncState? = null)

/** 电脑回答的同步设置：同步哪些相册、只在 Wi-Fi / 充电时 */
data class AlbumConfig(val wifiOnly: Boolean, val chargingOnly: Boolean, val syncing: Set<String>)

interface AlbumApi {
    suspend fun report(report: AlbumReport): AlbumConfig
}

/** phase：hash（读图算指纹）、upload（传） */
data class SyncProgress(val phase: String, val done: Int, val total: Int, val current: String?)

data class SyncResult(
    val config: AlbumConfig,
    val imported: Int,
    /** 电脑上本来就有 */
    val existing: Int,
    /** 电脑上删过的，不再传 */
    val skipped: Int,
    /** 没传成的（包括这次新发现电脑读不了的） */
    val failed: List<Pair<String, String>>,
    /** 这次新发现电脑读不了的（格式不支持）：记下，以后不再传 */
    val rejected: Int = 0,
    /** 传上去的里面，从 HEIF 转成 JPEG 的 */
    val converted: Int = 0,
) {
    /** 「同步了 12 张，1 张没传成」「13 张电脑读不了（格式不支持），不再传」「没有新图」 */
    fun text(): String = buildList {
        if (imported > 0) add("同步了 $imported 张" + if (converted > 0) "（$converted 张 HEIF 转成了 JPG）" else "")
        if (failed.size > rejected) add("${failed.size - rejected} 张没传成")
        if (rejected > 0) add("$rejected 张电脑读不了（格式不支持），不再传")
    }.joinToString("，").ifEmpty { "没有新图" }

    /** 报给电脑的结果：没有新图、也没出问题的那几次不报（电脑上留着上一次有结果的那句和它的时间） */
    fun summary(): String? = if (imported == 0 && failed.isEmpty()) null else text()
}

class AlbumSyncer(
    private val uploads: UploadApi,
    private val albums: AlbumApi,
    private val store: SyncStore,
    private val reader: MediaReader,
    /** 这个相册这次的批次 id：同一天同一个相册进同一批（电脑上「从手机传来的」不会一天几十条） */
    private val batchIdOf: (album: String) -> String,
    private val clock: () -> Long = System::currentTimeMillis,
    private val chunkSize: Int = Uploader.CHUNK_BYTES,
) {
    private var lastReport = 0L

    /** 进度报给电脑（电脑上看得到「正在盘点：3,000 / 12,363」）：最多 10 秒一次；报不上（网络）不要紧 */
    private suspend fun progress(running: String, done: Int, total: Int, force: Boolean = false) {
        val t = clock()
        if (!force && t - lastReport < REPORT_EVERY_MS) return
        lastReport = t
        try {
            albums.report(AlbumReport(emptyList(), full = false, state = AlbumSyncState(running, done, total)))
        } catch (e: IOException) {
            // 进度不要紧，真正的请求会再碰到网络问题
        }
    }

    /** 这张图的 sha256：算过而且大小、修改时间没变的直接用；读不到返回 null */
    private fun shaOf(item: MediaItem): String? {
        store.cachedSha(item.id, item.size, item.modifiedSec)?.let { return it }
        val sha = try {
            Uploader.sha256(reader.open(item))
        } catch (e: IOException) {
            return null
        } catch (e: SecurityException) {
            return null
        }
        store.putSha(item.id, item.size, item.modifiedSec, sha)
        return sha
    }

    private suspend fun check(shas: Collection<String>): Map<String, CheckHit> {
        val out = HashMap<String, CheckHit>()
        for (part in shas.distinct().chunked(Uploader.CHECK_MAX)) out.putAll(uploads.check(part.map { it to 1L }))
        return out
    }

    /** 盘点：所有相册的每张图问电脑，报每个相册的盘点结果。返回电脑的同步设置 */
    suspend fun inventory(items: List<MediaItem>, onProgress: suspend (SyncProgress) -> Unit = {}): AlbumConfig {
        progress("inventory", 0, items.size, force = true)
        val shas = HashMap<Long, String>()
        items.forEachIndexed { i, item ->
            coroutineContext.ensureActive()
            shaOf(item)?.let { shas[item.id] = it }
            onProgress(SyncProgress("hash", i + 1, items.size, item.album))
            progress("inventory", i + 1, items.size)
        }
        val hits = check(shas.values)
        val reported = items.groupBy { it.album }.map { (path, list) ->
            var have = 0
            var inTarget = 0
            var deleted = 0
            var new = 0
            var newBytes = 0L
            val folders = HashMap<String, Int>()
            for (item in list) {
                val sha = shas[item.id] ?: continue
                val hit = hits[sha] ?: continue
                when {
                    hit.imageId != null -> {
                        have++
                        if (hit.dir != null) {
                            inTarget++
                            folders[hit.dir] = (folders[hit.dir] ?: 0) + 1
                        }
                    }
                    hit.deleted -> deleted++
                    else -> {
                        new++
                        newBytes += item.size
                    }
                }
                // 电脑上有了、删过的：以后同步不用再管（内容变了才再看）；以前读不了的再试一次（电脑可能能读了）
                if (hit.imageId != null || hit.deleted) store.markHandled(item.id, sha)
                else if (store.handled(item.id)?.startsWith("rejected") == true) store.clearHandled(item.id)
            }
            val top = folders.entries.sortedWith(compareBy<Map.Entry<String, Int>>({ -it.value }, { it.key })).firstOrNull()
            albumOf(path, list).copy(inventory = AlbumInventory(list.size, have, inTarget, deleted, new, newBytes, top?.key, top?.value ?: 0))
        }
        store.retain(items.map { it.id }.toSet())
        return albums.report(
            AlbumReport(reported, full = true, state = AlbumSyncState(null, summary = "盘点了 ${reported.size} 个相册、${items.size} 张")),
        )
    }

    /** 同步一次：报相册清单、拿回要同步的相册，传这些相册里电脑上没有的图，报结果 */
    suspend fun sync(items: List<MediaItem>, onProgress: suspend (SyncProgress) -> Unit = {}): SyncResult {
        val all = albumsOf(items)
        val config = albums.report(AlbumReport(all, full = true, state = AlbumSyncState("sync", 0, 0)))
        lastReport = clock()
        val mine = items.filter { it.album in config.syncing }
        val todo = ArrayList<Pair<MediaItem, String>>()
        // 电脑读不了的（以前记下的和这次的）：每个相册几张
        val rejectedIn = HashMap<String, Int>()
        mine.forEachIndexed { i, item ->
            coroutineContext.ensureActive()
            val sha = shaOf(item)
            val handled = store.handled(item.id)
            when {
                sha == null || handled == sha -> Unit
                // 以前读不了的：HEIF 现在会转了，再试；别的（还有转过还被拒的）不再传
                (handled == REJECTED + sha && !isHeif(item)) || handled == REJECTED_JPEG + sha ->
                    rejectedIn[item.album] = (rejectedIn[item.album] ?: 0) + 1
                else -> todo += item to sha
            }
            onProgress(SyncProgress("hash", i + 1, mine.size, item.album))
        }
        var imported = 0
        var existing = 0
        var skipped = 0
        var rejected = 0
        var converted = 0
        val failed = mutableListOf<Pair<String, String>>()
        val pending = HashMap<String, Int>()
        if (todo.isNotEmpty()) {
            val hits = check(todo.map { it.second })
            val send = todo.filter { (item, sha) ->
                val hit = hits[sha]
                when {
                    hit?.imageId != null -> {
                        store.markHandled(item.id, sha)
                        existing++
                        false
                    }
                    hit?.deleted == true -> {
                        store.markHandled(item.id, sha)
                        skipped++
                        false
                    }
                    else -> true
                }
            }
            var done = 0
            if (send.isNotEmpty()) progress("sync", 0, send.size, force = true)
            for ((album, list) in send.groupBy { it.first.album }) {
                var newlyRejected = 0
                var failedHere = 0
                // 传一批：entries 是 (手机上的图, 原图的 sha256, 转好的 JPEG 或 null)
                suspend fun upload(entries: List<Triple<MediaItem, String, ByteArray?>>) {
                    val byKey = entries.associateBy { it.first.id.toString() }
                    val files = entries.map { (item, sha, jpeg) ->
                        UploadFile(
                            name = if (jpeg != null) jpegName(item.fileName) else item.fileName,
                            size = jpeg?.size?.toLong() ?: item.size,
                            modifiedAt = item.takenMs?.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() },
                            clientKey = item.id.toString(),
                            sha256 = if (jpeg != null) Uploader.sha256(ByteArrayInputStream(jpeg)) else sha,
                        ) { if (jpeg != null) ByteArrayInputStream(jpeg) else reader.open(item) }
                    }
                    val base = done
                    val summary = Uploader(uploads, chunkSize).run(
                        batchIdOf(album),
                        files,
                        album,
                        precheck = false,
                        onFile = { f, status ->
                            val (item, sha, jpeg) = byKey.getValue(f.clientKey!!)
                            when (status) {
                                "failed" -> Unit
                                "rejected" -> {
                                    // 记的是原图的 sha256（处理过没有按原图算）
                                    store.markHandled(item.id, (if (jpeg != null) REJECTED_JPEG else REJECTED) + sha)
                                    rejectedIn[album] = (rejectedIn[album] ?: 0) + 1
                                    newlyRejected++
                                    rejected++
                                }
                                else -> {
                                    store.markHandled(item.id, sha)
                                    if (jpeg != null && status == "imported") converted++
                                }
                            }
                        },
                        onProgress = { p ->
                            onProgress(SyncProgress("upload", base + p.done, send.size, p.current))
                            progress("sync", base + p.done, send.size)
                        },
                    )
                    done += files.size
                    imported += summary.imported
                    existing += summary.existing
                    failed += summary.failed
                    failedHere += summary.failed.size
                }
                val (heif, plain) = list.partition { (item, _) -> isHeif(item) }
                if (plain.isNotEmpty()) upload(plain.map { (item, sha) -> Triple(item, sha, null) })
                // HEIF：一张一张转、转完就传（不同时占着好几张图的内存）；转不了的记下不再试
                for ((item, sha) in heif) {
                    coroutineContext.ensureActive()
                    val jpeg = reader.toJpeg(item)
                    if (jpeg == null) {
                        store.markHandled(item.id, REJECTED_JPEG + sha)
                        rejectedIn[album] = (rejectedIn[album] ?: 0) + 1
                        rejected++
                        failed += item.fileName to "HEIF 转 JPEG 失败"
                        done++
                        continue
                    }
                    upload(listOf(Triple(item, sha, jpeg)))
                }
                // 没传成的里面，电脑读不了的不算「还没传上来」（不会再传）
                val retry = failedHere - newlyRejected
                if (retry > 0) pending[album] = retry
            }
        }
        val result = SyncResult(config, imported, existing, skipped, failed, rejected, converted)
        val final = albums.report(
            AlbumReport(
                all.filter { it.path in config.syncing }.map { it.copy(pending = pending[it.path] ?: 0, rejected = rejectedIn[it.path] ?: 0) },
                full = false,
                state = AlbumSyncState(null, summary = result.summary()),
            ),
        )
        return result.copy(config = final)
    }

    /** 文件头是 HEIF（电脑读不了，要先转成 JPEG）；读不到算不是 */
    private fun isHeif(item: MediaItem): Boolean = try {
        reader.open(item).use { input ->
            val head = ByteArray(12)
            var n = 0
            while (n < head.size) {
                val r = input.read(head, n, head.size - n)
                if (r < 0) break
                n += r
            }
            n == head.size && heif(head)
        }
    } catch (e: IOException) {
        false
    } catch (e: SecurityException) {
        false
    }

    companion object {
        const val REPORT_EVERY_MS = 10_000L
        /** 处理过的记号：电脑读不了的记成 rejected:<sha256>，转过 JPEG 还被拒的记成 rejected-jpeg:<sha256> */
        const val REJECTED = "rejected:"
        const val REJECTED_JPEG = "rejected-jpeg:"

        private val HEIF_BRANDS = setOf("heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1")

        /** 文件头（前 12 个字节）是不是 HEIF：…ftyp + heic 这类品牌 */
        fun heif(head: ByteArray): Boolean =
            head.size >= 12 && String(head, 4, 4, Charsets.ISO_8859_1) == "ftyp" && String(head, 8, 4, Charsets.ISO_8859_1) in HEIF_BRANDS

        /** 转成 JPEG 后的文件名：本来就叫 .jpg 的不改，别的换成 .jpg */
        fun jpegName(name: String): String {
            val lower = name.lowercase()
            return if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) name else name.substringBeforeLast('.', name) + ".jpg"
        }

        private fun albumOf(path: String, list: List<MediaItem>) = ReportedAlbum(
            path = path,
            name = list.first().albumName.ifBlank { path.substringAfterLast('/') },
            count = list.size,
            bytes = list.sumOf { it.size },
            latestAt = list.maxOf { it.modifiedSec }.takeIf { it > 0 }?.let { Instant.ofEpochSecond(it).toString() },
        )

        /** 手机上的相册清单：张数、大小、最新一张的时间 */
        fun albumsOf(items: List<MediaItem>): List<ReportedAlbum> =
            items.groupBy { it.album }.map { (path, list) -> albumOf(path, list) }.sortedBy { it.path }

        /** MediaStore 的 RELATIVE_PATH → 相册路径：'Download/' → 'Download'；空的（存储根目录）是 null */
        fun albumPath(relativePath: String?): String? =
            relativePath?.replace('\\', '/')?.split('/')?.filter { it.isNotEmpty() }?.joinToString("/")?.ifEmpty { null }
    }
}
