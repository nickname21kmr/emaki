package app.emaki.mobile.platform

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.emaki.mobile.core.KeyValueStore
import app.emaki.mobile.core.SecretBox
import app.emaki.mobile.core.ServerStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** SharedPreferences 做的键值存储 */
class PrefsStore(private val prefs: SharedPreferences) : KeyValueStore {
    override fun get(key: String): String? = prefs.getString(key, null)

    @Suppress("ApplySharedPref")
    override fun put(values: Map<String, String?>) {
        val e = prefs.edit()
        for ((k, v) in values) if (v == null) e.remove(k) else e.putString(k, v)
        // 凭证要马上落盘：被杀掉也不丢
        e.commit()
    }
}

/**
 * Android Keystore 里的 AES-256-GCM 密钥（不能导出，卸载 App 就没了）。密文 = 12 字节 IV ‖ 密文和 16 字节标签。
 * 设备凭证用它加密后存进 SharedPreferences（docs/mobile.md 2.3 第 4 条）。
 */
class KeystoreBox(private val alias: String = "emaki-device-token") : SecretBox {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, key())
        return c.iv + c.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "密文太短" }
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return c.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

fun serverStore(context: Context): ServerStore =
    ServerStore(PrefsStore(context.getSharedPreferences("emaki", Context.MODE_PRIVATE)), KeystoreBox())
