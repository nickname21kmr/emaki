package app.emaki.mobile.platform

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import app.emaki.mobile.core.SyncStore

/**
 * 同步相册在手机上记的（docs/mobile.md 5.5）：每张图算过的 sha256（按 MediaStore 的 id + 大小 + 修改时间，没变就不重算），
 * 处理过的（电脑上有了、删过的、传过的：记下当时的 sha256，内容变了就不算）。
 * 换了一台电脑：处理过的清掉（那台电脑上不一定有），算过的 sha256 留着。
 */
class SyncDb(context: Context) : SQLiteOpenHelper(context, "album-sync.db", null, 1), SyncStore {
    /** 盘点时一张图写一次：WAL + synchronous=NORMAL，不然上万次单独提交很慢 */
    override fun onConfigure(db: SQLiteDatabase) {
        db.enableWriteAheadLogging()
        db.execSQL("PRAGMA synchronous = NORMAL")
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE media (id INTEGER PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL, sha256 TEXT NOT NULL, handled TEXT)")
        db.execSQL("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    /** 这次同步的是哪台电脑；换了就把处理过的清掉 */
    fun forServer(serverId: String) {
        val db = writableDatabase
        val current = db.rawQuery("SELECT value FROM meta WHERE key = 'server'", null).use { c -> if (c.moveToFirst()) c.getString(0) else null }
        if (current == serverId) return
        db.beginTransaction()
        try {
            db.execSQL("UPDATE media SET handled = NULL")
            db.execSQL("INSERT OR REPLACE INTO meta (key, value) VALUES ('server', ?)", arrayOf(serverId))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    override fun cachedSha(id: Long, size: Long, modifiedSec: Long): String? =
        readableDatabase.rawQuery("SELECT sha256 FROM media WHERE id = ? AND size = ? AND modified = ?", arrayOf(id.toString(), size.toString(), modifiedSec.toString()))
            .use { c -> if (c.moveToFirst()) c.getString(0) else null }

    override fun putSha(id: Long, size: Long, modifiedSec: Long, sha256: String) {
        val v = ContentValues().apply {
            put("size", size)
            put("modified", modifiedSec)
            put("sha256", sha256)
        }
        // 安卓 10 的 SQLite 没有 UPSERT：先改，没有再插（处理过的那一列不动）
        if (writableDatabase.update("media", v, "id = ?", arrayOf(id.toString())) == 0) {
            v.put("id", id)
            writableDatabase.insert("media", null, v)
        }
    }

    override fun handled(id: Long): String? =
        readableDatabase.rawQuery("SELECT handled FROM media WHERE id = ?", arrayOf(id.toString())).use { c -> if (c.moveToFirst()) c.getString(0) else null }

    override fun markHandled(id: Long, sha256: String) {
        writableDatabase.execSQL("UPDATE media SET handled = ? WHERE id = ?", arrayOf(sha256, id))
    }

    override fun retain(ids: Set<Long>) {
        val db = writableDatabase
        val gone = db.rawQuery("SELECT id FROM media", null).use { c -> buildList { while (c.moveToNext()) c.getLong(0).let { if (it !in ids) add(it) } } }
        if (gone.isEmpty()) return
        db.beginTransaction()
        try {
            for (part in gone.chunked(500)) db.execSQL("DELETE FROM media WHERE id IN (${part.joinToString(",")})")
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }
}
