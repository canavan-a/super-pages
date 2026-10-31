package com.superpagesapp

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors

/**
 * Key-file scrypt off the JS thread (see Scrypt.java). Inputs and output are
 * base64 so the bridge only carries strings.
 */
class ScryptModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "Scrypt"

  private val worker = Executors.newSingleThreadExecutor()

  @ReactMethod
  fun derive(pass: String, salt: String, n: Int, r: Int, p: Int, dkLen: Int, promise: Promise) {
    worker.execute {
      try {
        val key =
            Scrypt.derive(
                Base64.decode(pass, Base64.NO_WRAP), Base64.decode(salt, Base64.NO_WRAP), n, r, p, dkLen)
        promise.resolve(Base64.encodeToString(key, Base64.NO_WRAP))
      } catch (e: OutOfMemoryError) {
        promise.reject("E_SCRYPT", "Not enough memory to open this key file.")
      } catch (e: Exception) {
        promise.reject("E_SCRYPT", e.message ?: "scrypt failed", e)
      }
    }
  }
}
