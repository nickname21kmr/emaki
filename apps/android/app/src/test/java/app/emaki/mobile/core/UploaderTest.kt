package app.emaki.mobile.core

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.MessageDigest

/** 假电脑的上传接口：照 apps/server/src/domain/upload/upload.ts 的规则回答（断点、传过的、内容核对） */
internal class FakeUploads(val have: MutableMap<String, String> = mutableMapOf()) : UploadApi {
    class Up(val id: String, val sha: String, val size: Long, var data: ByteArray = ByteArray(0), var status: String = "receiving", var imageId: String? = null)

    val uploads = mutableMapOf<String, Up>()
    var puts = 0
    var checks = 0
    /** 第几次 PUT 时网络断掉（IOException），null = 不断 */
    var dropAtPut: Int? = null
    /** complete 时回 400 的文件（内容对不上） */
    val rejectSha = mutableSetOf<String>()
    /** 下一次 PUT 回 409（另一个任务改了断点） */
    var conflictOnce = false
    /** 下一个传完的文件内容被弄坏（complete 回 400，内容和 sha256 对不上） */
    var corruptOnce = false
    var revoked = false
    /** 电脑上删过的（回收站里） */
    val deleted = mutableSetOf<String>()
    /** 在这台设备「上传到」里的图所在的文件夹 */
    val dirs = mutableMapOf<String, String>()
    val begins = mutableListOf<BeginRequest>()
    private var nextImage = 100

    private fun guard() {
        if (revoked) throw ApiException(401, "device_revoked", "这台设备已经被电脑移除")
    }

    override suspend fun check(files: List<Pair<String, Long>>): Map<String, CheckHit> {
        guard()
        checks++
        return files.associate { (sha, _) -> sha to CheckHit(have[sha], deleted = have[sha] == null && sha in deleted, dir = if (have[sha] != null) dirs[sha] else null) }
    }

    override suspend fun begin(request: BeginRequest): BeginResult {
        guard()
        begins += request
        uploads.values.firstOrNull { it.sha == request.sha256 && it.status == "imported" }?.let { return BeginResult(it.id, it.size, "imported", it.imageId) }
        uploads.values.firstOrNull { it.sha == request.sha256 && it.status == "receiving" }?.let { return BeginResult(it.id, it.data.size.toLong(), "receiving", null) }
        val u = Up("u${uploads.size + 1}", request.sha256, request.size)
        uploads[u.id] = u
        return BeginResult(u.id, 0, "receiving", null)
    }

    override suspend fun put(uploadId: String, offset: Long, bytes: ByteArray, length: Int): Long {
        guard()
        puts++
        if (dropAtPut == puts) throw IOException("网络断了")
        val u = uploads.getValue(uploadId)
        if (conflictOnce) {
            conflictOnce = false
            throw ApiException(409, "conflict", "断点对不上")
        }
        if (offset != u.data.size.toLong()) throw ApiException(409, "conflict", "断点对不上：电脑上已收到 ${u.data.size} 字节")
        u.data += bytes.copyOf(length)
        return u.data.size.toLong()
    }

    override suspend fun complete(uploadId: String): CompleteResult {
        guard()
        val u = uploads.getValue(uploadId)
        if (u.data.size.toLong() != u.size) throw ApiException(409, "conflict", "还没传完")
        if (corruptOnce) {
            corruptOnce = false
            u.data = u.data.copyOf().also { it[0] = (it[0] + 1).toByte() }
        }
        if (sha(u.data) != u.sha) {
            u.status = "failed"
            throw ApiException(400, "bad_request", "传上来的内容和 sha256 对不上")
        }
        if (u.sha in rejectSha) {
            u.status = "failed"
            throw ApiException(422, "unsupported", "电脑读不了这个文件：不支持的格式：heif")
        }
        u.status = "imported"
        u.imageId = (nextImage++).toString()
        have[u.sha] = u.imageId!!
        return CompleteResult("imported", u.imageId!!)
    }
}

internal fun sha(b: ByteArray) = Hex.encode(MessageDigest.getInstance("SHA-256").digest(b))
internal fun bytes(n: Int, seed: Int) = ByteArray(n) { ((it * 31 + seed) and 0xff).toByte() }
private fun file(name: String, data: ByteArray) = UploadFile(name, data.size.toLong(), "2026-11-20T00:00:00Z") { ByteArrayInputStream(data) }

class UploaderTest {
    @Test
    fun skipsWhatTheComputerHasAndSendsTheRestInChunks() = runTest {
        val a = bytes(10_000, 1)
        val b = bytes(2_500, 2)
        val api = FakeUploads(mutableMapOf(sha(b) to "7"))
        val progress = mutableListOf<UploadProgress>()
        val s = Uploader(api, chunkSize = 4_096).run("batch-1", listOf(file("a.png", a), file("b.png", b))) { progress += it }
        assertEquals(UploadSummary(imported = 1, existing = 1, failed = emptyList()), s)
        assertEquals("已传 1 张，1 张电脑上本来就有", s.text())
        assertEquals(3, api.puts) // 10000 = 4096 + 4096 + 1808
        assertArrayEquals(a, api.uploads.values.single().data)
        assertEquals(1, api.checks)
        assertEquals(UploadProgress(2, 2, null), progress.last())
    }

    @Test
    fun networkDropThrowsAndARerunResumesFromTheOffset() = runTest {
        val a = bytes(10_000, 3)
        val api = FakeUploads().apply { dropAtPut = 2 }
        try {
            Uploader(api, chunkSize = 4_096).run("b", listOf(file("a.png", a)))
            fail("网络断了要抛 IOException，交给 WorkManager 重试")
        } catch (e: IOException) {
            // 预期
        }
        assertEquals(4_096, api.uploads.values.single().data.size)
        // 重跑：begin 拿到断点 4096，只传剩下的两段
        val s = Uploader(api, chunkSize = 4_096).run("b", listOf(file("a.png", a)))
        assertEquals(1, s.imported)
        assertArrayEquals(a, api.uploads.values.single().data)
        assertEquals(4, api.puts) // 第一次 1 段成功 + 1 段断掉，第二次 2 段
    }

    @Test
    fun alreadyUploadedFilesAreNotSentAgain() = runTest {
        val a = bytes(5_000, 4)
        val api = FakeUploads()
        Uploader(api, chunkSize = 4_096).run("b", listOf(file("a.png", a)))
        val puts = api.puts
        val s = Uploader(api, chunkSize = 4_096).run("b2", listOf(file("a.png", a)))
        assertEquals(UploadSummary(0, 1, emptyList()), s)
        assertEquals(puts, api.puts)
    }

    @Test
    fun offsetConflictRebeginsAndContinues() = runTest {
        val a = bytes(6_000, 5)
        val api = FakeUploads().apply { conflictOnce = true }
        val s = Uploader(api, chunkSize = 4_096).run("b", listOf(file("a.png", a)))
        assertEquals(1, s.imported)
        assertArrayEquals(a, api.uploads.values.single().data)
    }

    @Test
    fun aRejectedFileIsReportedAndTheOthersStillGo() = runTest {
        val bad = bytes(1_000, 6)
        val good = bytes(1_000, 7)
        val api = FakeUploads().apply { rejectSha += sha(bad) }
        val s = Uploader(api).run("b", listOf(file("bad.png", bad), file("good.png", good)))
        assertEquals(1, s.imported)
        assertEquals(listOf("bad.png" to "电脑读不了这个文件：不支持的格式：heif"), s.failed)
        assertEquals("已传 1 张，1 张没传成", s.text())
    }

    @Test
    fun removedDeviceStopsTheWholeBatch() = runTest {
        val api = FakeUploads().apply { revoked = true }
        try {
            Uploader(api).run("b", listOf(file("a.png", bytes(10, 8))))
            fail("设备被移除要抛出来")
        } catch (e: ApiException) {
            assertTrue(e.revoked)
        }
    }

    @Test
    fun uploadJsonMatchesTheServer() {
        val body = org.json.JSONObject(Json.uploadBeginBody(BeginRequest("b1", "ab", 12, "a.png", null, "Download", "media:1")))
        assertEquals("Download", body.getString("album"))
        assertTrue(!body.has("modifiedAt"))
        assertEquals(
            mapOf("x" to CheckHit("3", false, "下载"), "y" to CheckHit(null, true, null), "z" to CheckHit(null)),
            Json.uploadCheck(
                """{"results":[{"sha256":"x","imageId":"3","deleted":false,"dir":"下载"},{"sha256":"y","imageId":null,"deleted":true,"dir":null},{"sha256":"z","imageId":null}]}""",
            ),
        )
        assertEquals(BeginResult("u1", 5, "receiving", null), Json.uploadBegin("""{"uploadId":"u1","received":5,"status":"receiving","imageId":null}"""))
        assertEquals(CompleteResult("existing", "9"), Json.uploadComplete("""{"ok":true,"message":"x","status":"existing","imageId":"9"}"""))
    }
}
