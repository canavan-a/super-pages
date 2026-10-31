package com.superpagesapp

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * "Save as…" through the system file picker (ACTION_CREATE_DOCUMENT), so the
 * user chooses where a file lands instead of it being dropped in Downloads.
 * The picker remembers the last folder used.
 *
 * Two steps so the JS side can open the picker straight away and do slow work
 * (encrypting a key file) only once a location is chosen: create() resolves
 * with a content:// URI (or null if cancelled), then write() fills it, or
 * discard() removes it if that work failed.
 */
class FileSaverModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "FileSaver"

  private var pending: Promise? = null

  private val listener: ActivityEventListener =
      object : BaseActivityEventListener() {
        override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
          if (requestCode != REQUEST_CREATE) return
          val p = pending ?: return
          pending = null
          val uri = data?.data
          p.resolve(if (resultCode == Activity.RESULT_OK && uri != null) uri.toString() else null)
        }
      }

  init {
    reactContext.addActivityEventListener(listener)
  }

  @ReactMethod
  fun create(name: String, mime: String, promise: Promise) {
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "The app isn't in the foreground.")
      return
    }
    pending?.resolve(null)
    pending = promise
    val intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = mime
          putExtra(Intent.EXTRA_TITLE, name)
        }
    try {
      activity.startActivityForResult(intent, REQUEST_CREATE)
    } catch (e: Exception) {
      pending = null
      promise.reject("E_NO_PICKER", "Couldn't open the save dialog.", e)
    }
  }

  /** Writes [base64] to [uri] and resolves with the name the user gave it. */
  @ReactMethod
  fun write(uri: String, base64: String, promise: Promise) {
    try {
      val u = Uri.parse(uri)
      val resolver = reactContext.contentResolver
      // "wt" truncates, in case the user picked an existing file to replace.
      resolver.openOutputStream(u, "wt").use { out ->
        out ?: throw IllegalStateException("Couldn't open the file for writing.")
        out.write(Base64.decode(base64, Base64.DEFAULT))
      }
      val name =
          resolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
          }
      promise.resolve(name)
    } catch (e: Exception) {
      promise.reject("E_WRITE", e.message ?: "Couldn't write the file.", e)
    }
  }

  /** Deletes the empty file create() made; best effort. */
  @ReactMethod
  fun discard(uri: String, promise: Promise) {
    try {
      DocumentsContract.deleteDocument(reactContext.contentResolver, Uri.parse(uri))
    } catch (_: Exception) {}
    promise.resolve(null)
  }

  companion object {
    private const val REQUEST_CREATE = 0x5afe
  }
}
