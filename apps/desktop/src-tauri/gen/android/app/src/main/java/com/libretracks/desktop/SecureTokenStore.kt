package com.libretracks.desktop

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypted storage for the Google Drive refresh token.
 *
 * # Why this exists at all
 *
 * The desktop builds keep that token in the OS credential store (Credential
 * Manager, Keychain, Secret Service) through the `keyring` crate, which has no
 * Android backend. A refresh token is standing authorisation to reach part of a
 * real person's Drive until they revoke it, so dropping it into plain app
 * storage was not an acceptable substitute.
 *
 * # Why the Keystore directly, and not Jetpack Security
 *
 * `EncryptedSharedPreferences` would do the same job and add a dependency whose
 * maintenance status has been in question for a while. Going straight to
 * `AndroidKeyStore` costs about fifty lines, adds nothing to the build, and
 * gets the same property that actually matters: the AES key never leaves the
 * keystore, and lives in hardware on any device that has a TEE or StrongBox.
 * Only the ciphertext reaches SharedPreferences.
 *
 * Called from Rust over JNI — see `platform/android_token_store.rs`.
 */
object SecureTokenStore {
    private const val PREFS = "libretracks_secure_tokens"
    private const val KEY_ALIAS = "libretracks_token_key"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    /** GCM authentication tag length, in bits. 128 is the maximum and the norm. */
    private const val TAG_BITS = 128

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
            return it.secretKey
        }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Deliberately NOT requiring user authentication: the token is
                // refreshed in the background while a set is being uploaded, and
                // a key that needs the lock screen would fail exactly then.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    @JvmStatic
    fun save(context: Context, name: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))

        // IV and ciphertext in one string: GCM needs the IV to decrypt and it is
        // not secret, but it MUST be unique per encryption — which is why it is
        // stored per value rather than fixed anywhere.
        val encoded = buildString {
            append(Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            append(':')
            append(Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        }

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(name, encoded)
            .apply()
    }

    /**
     * Returns null when there is nothing stored, and also when what is stored
     * can no longer be read.
     *
     * The key can be invalidated out from under us — a restored backup carries
     * the ciphertext to a device whose keystore never had the key, and some
     * lock-screen changes drop keys as well. Reporting that as an error would
     * leave the user permanently unable to connect with no way out from inside
     * the app; reporting "nothing stored" asks them to sign in again, which
     * always works.
     */
    @JvmStatic
    fun load(context: Context, name: String): String? {
        val encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(name, null)
            ?: return null

        return try {
            val (ivPart, dataPart) = encoded.split(':', limit = 2).let {
                if (it.size != 2) return null else it[0] to it[1]
            }
            val iv = Base64.decode(ivPart, Base64.NO_WRAP)
            val ciphertext = Base64.decode(dataPart, Base64.NO_WRAP)

            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (error: Exception) {
            clear(context, name)
            null
        }
    }

    @JvmStatic
    fun clear(context: Context, name: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(name)
            .apply()
    }
}
