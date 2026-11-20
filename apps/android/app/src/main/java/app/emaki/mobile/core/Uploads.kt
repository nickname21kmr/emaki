package app.emaki.mobile.core

import kotlinx.coroutines.ensureActive
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/**
 * 把手机上的图传给电脑（docs/mobile.md 5.4），照 apps/server/scripts/lan-client.ts 的 upload 写：
 * 先算 sha256、问电脑有没有（只传没有的）→ begin（传过的直接 done，传了一半的拿到断点）→ 一段段 PUT → complete。
 * B1（手动选图）和 B2（同步相册）都用它；网络断了抛 IOException，交给调用方（WorkManager）过一会儿重跑：
 * 已经传完的 begin 直接回 done，传了一半的从断点接着传，不会重复。
 */

/** 手机上的一个文件：名字、大小、修改时间（ISO）、怎么读（每次调用打开一个新的流） */
class UploadFile(
    val name: String,
    val size: Long,
    val modifiedAt: String?,
    /** 相册同步用：手机上这个文件的标识（MediaStore 的 id），手动上传不给 */
    val clientKey: String? = null,
    /** 已经算好的 sha256（相册同步先盘点过）；null = 传之前现算 */
    val sha256: String? = null,
    val open: () -> InputStream,
)

/** 问电脑「这个 sha256 你有没有」的回答（apps/server/src/domain/upload/upload.ts 的 checkUploads） */
data class CheckHit(
    /** 图库里内容相同的图；没有是 null */
    val imageId: String?,
    /** 没有，但删过（在回收站里、或者文件丢了）：同步相册不再传 */
    val deleted: Boolean = false,
    /** 那张图在这台设备的「上传到」里：所在的文件夹（相对「上传到」）；不在里面是 null */
    val dir: String? = null,
)

data class BeginRequest(
    val batchId: String,
    val sha256: String,
    val size: Long,
    val fileName: String,
    val modifiedAt: String?,
    val album: String?,
    val clientKey: String?,
)

/** status：receiving（接着传）、imported / existing（这台设备传过同一个文件） */
data class BeginResult(val uploadId: String, val received: Long, val status: String, val imageId: String?)

/** status：imported（入库了）、existing（电脑上本来就有） */
data class CompleteResult(val status: String, val imageId: String)

/** 电脑这一侧的上传接口；测试里换成假的 */
interface UploadApi {
    /** sha256 → 电脑上有没有、删过没有、在哪个文件夹；一次最多 500 个 */
    suspend fun check(files: List<Pair<String, Long>>): Map<String, CheckHit>
    suspend fun begin(request: BeginRequest): BeginResult
    /** 传一段（bytes 的前 length 个字节），返回电脑上已收到的字节数 */
    suspend fun put(uploadId: String, offset: Long, bytes: ByteArray, length: Int): Long
    suspend fun complete(uploadId: String): CompleteResult
}

data class UploadProgress(
    /** 处理完的文件数（传完的、本来就有的、失败的都算） */
    val done: Int,
    val total: Int,
    /** 正在传的那个 */
    val current: String?,
)

data class UploadSummary(val imported: Int, val existing: Int, val failed: List<Pair<String, String>>) {
    /** 「已传 8 张，2 张电脑上本来就有，1 张没传成」 */
    fun text(): String = buildList {
        add("已传 $imported 张")
        if (existing > 0) add("$existing 张电脑上本来就有")
        if (failed.isNotEmpty()) add("${failed.size} 张没传成")
    }.joinToString("，")
}

class Uploader(
    private val api: UploadApi,
    private val chunkSize: Int = CHUNK_BYTES,
    /** 一个文件里遇到 409（断点对不上）时重新 begin 的次数 */
    private val resyncs: Int = 3,
) {
    /**
     * 传一批。网络问题（IOException）、设备被移除（401）原样抛出，整批停下；单个文件被电脑拒绝（400，例如内容和哈希对不上、不是图片）
     * 记进 failed，接着传下一个。
     *
     * precheck：先问电脑有没有，有的不传（手动上传）；相册同步自己问过了（还要跳过删过的），传 false。
     * onFile：每个文件的结果（imported / existing / failed / rejected：电脑读不了），相册同步据此记下传过的、读不了的
     */
    suspend fun run(
        batchId: String,
        files: List<UploadFile>,
        album: String? = null,
        precheck: Boolean = true,
        onFile: (UploadFile, String) -> Unit = { _, _ -> },
        onProgress: suspend (UploadProgress) -> Unit = {},
    ): UploadSummary {
        val hashed = files.map { f -> Hashed(f, f.sha256 ?: sha256(f)) }
        val have = HashMap<String, CheckHit>()
        if (precheck) for (part in hashed.chunked(CHECK_MAX)) have.putAll(api.check(part.map { it.sha256 to it.file.size }))
        var imported = 0
        var existing = 0
        val failed = mutableListOf<Pair<String, String>>()
        hashed.forEachIndexed { i, h ->
            coroutineContext.ensureActive()
            onProgress(UploadProgress(i, hashed.size, h.file.name))
            if (have[h.sha256]?.imageId != null) {
                existing++
                onFile(h.file, "existing")
                return@forEachIndexed
            }
            try {
                val status = one(batchId, h, album).status
                if (status == "imported") imported++ else existing++
                onFile(h.file, status)
            } catch (e: ApiException) {
                if (e.unauthorized || e.status >= 500) throw e
                failed += h.file.name to (e.message ?: "电脑拒绝了（${e.status}）")
                // 422：电脑读不了这个文件（格式不支持），同一个内容再传也一样
                onFile(h.file, if (e.status == 422) "rejected" else "failed")
            }
        }
        onProgress(UploadProgress(hashed.size, hashed.size, null))
        return UploadSummary(imported, existing, failed)
    }

    private class Hashed(val file: UploadFile, val sha256: String)

    private suspend fun one(batchId: String, h: Hashed, album: String?): CompleteResult {
        val f = h.file
        var attempt = 0
        while (true) {
            val b = api.begin(BeginRequest(batchId, h.sha256, f.size, f.name, f.modifiedAt, album, f.clientKey))
            if (b.status != "receiving") return CompleteResult(b.status, b.imageId ?: "")
            try {
                send(b.uploadId, b.received, f)
                return api.complete(b.uploadId)
            } catch (e: ApiException) {
                // 断点对不上（另一个任务也在传、上次的回答没收到）：重新 begin 拿到电脑上的断点
                if (e.status != 409 || ++attempt > resyncs) throw e
            }
        }
    }

    private suspend fun send(uploadId: String, from: Long, f: UploadFile) {
        if (from >= f.size) return
        f.open().use { input ->
            skipFully(input, from)
            val buf = ByteArray(chunkSize)
            var offset = from
            while (offset < f.size) {
                coroutineContext.ensureActive()
                val n = readUpTo(input, buf, minOf(chunkSize.toLong(), f.size - offset).toInt())
                if (n <= 0) throw IOException("「${f.name}」读到一半没有了（手机上的文件变了？）")
                offset = api.put(uploadId, offset, buf, n)
            }
        }
    }

    companion object {
        /** 一段 4 MiB（电脑上限是 8 MiB） */
        const val CHUNK_BYTES = 4 * 1024 * 1024
        const val CHECK_MAX = 500

        fun sha256(f: UploadFile): String = sha256(f.open())

        /** 读完这个流算 sha256（读完关掉） */
        fun sha256(stream: InputStream): String {
            val md = MessageDigest.getInstance("SHA-256")
            stream.use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return Hex.encode(md.digest())
        }

        private fun skipFully(input: InputStream, n: Long) {
            var left = n
            while (left > 0) {
                val s = input.skip(left)
                if (s > 0) {
                    left -= s
                    continue
                }
                // skip 不动了：读一个字节看看是不是到头了
                if (input.read() < 0) throw IOException("文件比断点短")
                left--
            }
        }

        private fun readUpTo(input: InputStream, buf: ByteArray, want: Int): Int {
            var got = 0
            while (got < want) {
                val n = input.read(buf, got, want - got)
                if (n < 0) break
                got += n
            }
            return got
        }
    }
}
