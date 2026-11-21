package app.emaki.mobile.core

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.IOException

/** 假电脑的同步相册接口：记下每次报的，回答同步哪些相册 */
private class FakeAlbums(val syncing: MutableSet<String> = mutableSetOf()) : AlbumApi {
    val reports = mutableListOf<AlbumReport>()
    override suspend fun report(report: AlbumReport): AlbumConfig {
        reports += report
        return AlbumConfig(wifiOnly = true, chargingOnly = false, syncing = syncing.toSet())
    }
}

private class MemoryStore : SyncStore {
    val shas = mutableMapOf<Long, Triple<Long, Long, String>>()
    val handled = mutableMapOf<Long, String>()
    override fun cachedSha(id: Long, size: Long, modifiedSec: Long): String? =
        shas[id]?.takeIf { it.first == size && it.second == modifiedSec }?.third
    override fun putSha(id: Long, size: Long, modifiedSec: Long, sha256: String) {
        shas[id] = Triple(size, modifiedSec, sha256)
    }
    override fun handled(id: Long): String? = handled[id]
    override fun markHandled(id: Long, sha256: String) {
        handled[id] = sha256
    }
    override fun clearHandled(id: Long) {
        handled.remove(id)
    }
    override fun retain(ids: Set<Long>) {
        shas.keys.retainAll(ids)
        handled.keys.retainAll(ids)
    }
}

/** 假相册：id → 内容；opens 数读了几次（算过的不该再读） */
private class Phone {
    val data = mutableMapOf<Long, ByteArray>()
    val items = mutableListOf<MediaItem>()
    var opens = 0
    val missing = mutableSetOf<Long>()
    fun add(id: Long, album: String, bytes: ByteArray, name: String = "$id.png", modified: Long = 1_700_000_000L): MediaItem {
        data[id] = bytes
        val item = MediaItem(id, album, album.substringAfterLast('/'), name, bytes.size.toLong(), modified, modified * 1000)
        items.removeAll { it.id == id }
        items += item
        return item
    }
    /** 转过 JPEG 的（id） */
    val converted = mutableListOf<Long>()
    val reader = object : MediaReader {
        override fun open(item: MediaItem): java.io.InputStream {
            opens++
            if (item.id in missing) throw FileNotFoundException("没了")
            return ByteArrayInputStream(data.getValue(item.id))
        }

        /** 假的转换：HEIF 的内容前面加上 JPEG 的头 */
        override fun toJpeg(item: MediaItem): ByteArray? {
            converted += item.id
            return byteArrayOf(0xFF.toByte(), 0xD8.toByte()) + data.getValue(item.id)
        }
    }
}

class AlbumSyncTest {
    private val phone = Phone()
    private val computer = FakeUploads()
    private val albums = FakeAlbums()
    private val store = MemoryStore()
    private var t = 0L
    private fun syncer() = AlbumSyncer(computer, albums, store, phone.reader, batchIdOf = { "batch-$it" }, clock = { t }, chunkSize = 4_096)

    @Test
    fun inventoryCountsEachAlbumAndFindsWhereTheOldOnesAre() = runTest {
        // Download：3 张在 平板导入/下载、1 张在别处、1 张删过、1 张电脑上没有；截图：都没有
        val d = (1..6).map { bytes(500 + it, it) }
        d.forEachIndexed { i, b -> phone.add(i + 1L, "Download", b) }
        for (i in 0..2) computer.have[sha(d[i])] = "${i + 1}".also { computer.dirs[sha(d[i])] = "下载" }
        computer.have[sha(d[3])] = "9"
        computer.deleted += sha(d[4])
        phone.add(10, "DCIM/Screenshots", bytes(300, 10))
        val config = syncer().inventory(phone.items)
        assertEquals(emptySet<String>(), config.syncing)
        val full = albums.reports.last()
        assertTrue(full.full)
        assertNull(full.state?.running)
        assertEquals("盘点了 2 个相册、7 张", full.state?.summary)
        val download = full.albums.single { it.path == "Download" }
        assertEquals(AlbumInventory(6, 4, 3, 1, 1, d[5].size.toLong(), "下载", 3), download.inventory)
        assertEquals(6, download.count)
        assertEquals(AlbumInventory(1, 0, 0, 0, 1, 300, null, 0), full.albums.single { it.path == "DCIM/Screenshots" }.inventory)
        // 电脑上有了、删过的记下（以后不用再管）；电脑上没有的不记
        assertEquals(setOf(1L, 2L, 3L, 4L, 5L), store.handled.keys)
        // 一开始先报「正在盘点」
        assertEquals("inventory", albums.reports.first().state?.running)
    }

    @Test
    fun syncSendsOnlyWhatTheComputerLacksInSyncingAlbums() = runTest {
        val have = bytes(1_000, 1)
        val gone = bytes(1_000, 2)
        val fresh = bytes(9_000, 3)
        phone.add(1, "Download", have)
        phone.add(2, "Download", gone)
        phone.add(3, "Download", fresh, name = "151111643_p0.png")
        phone.add(4, "DCIM/Camera", bytes(800, 4))
        computer.have[sha(have)] = "7"
        computer.deleted += sha(gone)
        albums.syncing += "Download"
        val r = syncer().sync(phone.items)
        assertEquals(SyncResult(r.config, imported = 1, existing = 1, skipped = 1, failed = emptyList()), r)
        assertEquals("同步了 1 张", r.text())
        // 只传了没有的那张，带相册路径和 MediaStore 的 id
        val begin = computer.begins.single()
        assertEquals(listOf("151111643_p0.png", "Download", "3", "batch-Download"), listOf(begin.fileName, begin.album, begin.clientKey, begin.batchId))
        assertEquals("2023-11-14T22:13:20Z", begin.modifiedAt)
        // 相机没在同步：一张都没读
        assertTrue(store.shas.keys.none { it == 4L })
        // 第一次报全部相册（拿设置），最后报同步的相册还有几张没传
        assertTrue(albums.reports.first().full)
        assertEquals(listOf("DCIM/Camera", "Download"), albums.reports.first().albums.map { it.path })
        val last = albums.reports.last()
        assertEquals(listOf(ReportedAlbum("Download", "Download", 3, 11_000, "2023-11-14T22:13:20Z", pending = 0, rejected = 0)), last.albums)
        assertEquals(AlbumSyncState(null, summary = "同步了 1 张"), last.state)
    }

    @Test
    fun aSecondRunReadsNothingAndSendsNothing() = runTest {
        phone.add(1, "Download", bytes(2_000, 1))
        albums.syncing += "Download"
        syncer().sync(phone.items)
        val opens = phone.opens
        val r = syncer().sync(phone.items)
        assertEquals("没有新图", r.text())
        // 没有新图的那次不报结果：电脑上留着上一次的「同步了 1 张」
        assertNull(albums.reports.last().state?.summary)
        assertEquals(opens, phone.opens)
        assertEquals(1, computer.begins.size)
    }

    @Test
    fun anEditedImageIsSentAgainAsNewContent() = runTest {
        phone.add(1, "Download", bytes(2_000, 1))
        albums.syncing += "Download"
        syncer().sync(phone.items)
        phone.add(1, "Download", bytes(2_100, 9), modified = 1_700_000_500L)
        val r = syncer().sync(phone.items)
        assertEquals(1, r.imported)
        assertEquals(2, computer.begins.size)
    }

    @Test
    fun aNetworkDropStopsTheRunAndTheRerunOnlySendsTheRest() = runTest {
        val a = bytes(3_000, 1)
        val b = bytes(3_000, 2)
        phone.add(1, "Download", a)
        phone.add(2, "Download", b)
        albums.syncing += "Download"
        computer.dropAtPut = 2
        try {
            syncer().sync(phone.items)
            fail("网络断了要抛 IOException，交给 WorkManager 重试")
        } catch (e: IOException) {
            // 预期
        }
        assertEquals(setOf(1L), store.handled.keys)
        val r = syncer().sync(phone.items)
        assertEquals(1, r.imported)
        assertEquals(2, computer.uploads.size)
    }

    @Test
    fun unreadableImagesAreSkippedNotTreatedAsNetworkProblems() = runTest {
        phone.add(1, "Download", bytes(1_000, 1))
        phone.add(2, "Download", bytes(1_000, 2))
        phone.missing += 1
        albums.syncing += "Download"
        val r = syncer().sync(phone.items)
        assertEquals(1, r.imported)
    }

    @Test
    fun aFileTheComputerCannotReadIsNotSentAgainUntilTheNextInventory() = runTest {
        val heif = bytes(1_000, 1)
        phone.add(1, "Pictures/weibo", heif)
        phone.add(2, "Pictures/weibo", bytes(1_000, 2))
        computer.rejectSha += sha(heif)
        albums.syncing += "Pictures/weibo"
        val r = syncer().sync(phone.items)
        assertEquals("同步了 1 张，1 张电脑读不了（格式不支持），不再传", r.text())
        assertEquals(listOf(0 to 1), albums.reports.last().albums.map { it.pending to it.rejected })
        // 下一次：不再传，照样报读不了几张
        val begins = computer.begins.size
        val again = syncer().sync(phone.items)
        assertEquals("没有新图", again.text())
        assertEquals(begins, computer.begins.size)
        assertEquals(listOf(0 to 1), albums.reports.last().albums.map { it.pending to it.rejected })
        // 重新盘点：清掉记号，再试一次
        syncer().inventory(phone.items)
        syncer().sync(phone.items)
        assertEquals(begins + 1, computer.begins.size)
    }

    /** HEIF 的文件头（改成 .jpg 也一样） */
    private fun heifBytes(seed: Int) = "\u0000\u0000\u0000\u0018ftypheic".toByteArray(Charsets.ISO_8859_1) + bytes(900, seed)

    @Test
    fun heifIsConvertedToJpegBeforeUploading() = runTest {
        val heif = heifBytes(1)
        phone.add(1, "Pictures/weibo", heif, name = "img-1.jpg")
        phone.add(2, "Pictures/weibo", bytes(1_000, 2))
        computer.rejectSha += sha(heif) // 电脑读不了原图
        albums.syncing += "Pictures/weibo"
        val r = syncer().sync(phone.items)
        assertEquals("同步了 2 张（1 张 HEIF 转成了 JPG）", r.text())
        assertEquals(listOf(1L), phone.converted)
        val sent = computer.begins.single { it.clientKey == "1" }
        assertEquals("img-1.jpg", sent.fileName)
        assertEquals(sha(byteArrayOf(0xFF.toByte(), 0xD8.toByte()) + heif), sent.sha256)
        // 处理过的记的是原图：下次不再转、不再传
        assertEquals(sha(heif), store.handled[1L])
        val begins = computer.begins.size
        assertEquals("没有新图", syncer().sync(phone.items).text())
        assertEquals(begins, computer.begins.size)
        assertEquals(listOf(0 to 0), albums.reports.last().albums.map { it.pending to it.rejected })
    }

    @Test
    fun heifRejectedByAnOlderAppIsConvertedNow() = runTest {
        val heif = heifBytes(3)
        phone.add(1, "Pictures/weibo", heif, name = "x.heic")
        store.putSha(1, heif.size.toLong(), 1_700_000_000L, sha(heif))
        store.markHandled(1, AlbumSyncer.REJECTED + sha(heif)) // 0.3.1 记下的「读不了」
        albums.syncing += "Pictures/weibo"
        val r = syncer().sync(phone.items)
        assertEquals(1, r.imported)
        assertEquals("x.jpg", computer.begins.single().fileName)
    }

    @Test
    fun aCorruptedTransferIsPendingAndRetried() = runTest {
        phone.add(1, "Pictures/bili", bytes(1_000, 1))
        albums.syncing += "Pictures/bili"
        computer.corruptOnce = true
        val r = syncer().sync(phone.items)
        assertEquals("1 张没传成", r.text())
        assertEquals(listOf(1 to 0), albums.reports.last().albums.map { it.pending to it.rejected })
        assertFalse(store.handled.containsKey(1L))
        assertEquals(1, syncer().sync(phone.items).imported)
    }

    @Test
    fun albumPathsAndJson() {
        assertEquals("Download", AlbumSyncer.albumPath("Download/"))
        assertEquals("Download/QQBrowser/1700284633722/图片收藏", AlbumSyncer.albumPath("Download/QQBrowser/1700284633722/图片收藏/"))
        assertNull(AlbumSyncer.albumPath("/"))
        assertNull(AlbumSyncer.albumPath(null))
        assertTrue(AlbumSyncer.heif("\u0000\u0000\u0000\u0030ftypheic\u0000\u0000".toByteArray(Charsets.ISO_8859_1)))
        assertFalse(AlbumSyncer.heif(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1)))
        assertEquals("a.jpg", AlbumSyncer.jpegName("a.heic"))
        assertEquals("img-1.JPG", AlbumSyncer.jpegName("img-1.JPG"))
        val body = JSONObject(
            Json.albumReportBody(
                AlbumReport(
                    listOf(ReportedAlbum("Download", "Download", 2, 30, null, AlbumInventory(2, 1, 1, 0, 1, 10, null, 0), pending = 1)),
                    full = true,
                    state = AlbumSyncState("sync", 1, 2),
                ),
            ),
        )
        assertTrue(body.getBoolean("full"))
        val a = body.getJSONArray("albums").getJSONObject(0)
        assertTrue(a.getJSONObject("inventory").isNull("folder"))
        assertFalse(a.has("latestAt"))
        assertEquals(1, a.getInt("pending"))
        assertEquals("sync", body.getJSONObject("state").getString("running"))
        assertEquals(
            AlbumConfig(wifiOnly = false, chargingOnly = true, syncing = setOf("Download")),
            Json.albumConfig("""{"ok":true,"message":"已收到","wifiOnly":false,"chargingOnly":true,"albums":[{"path":"Download","sync":true},{"path":"DCIM/Camera","sync":false}]}"""),
        )
    }
}
