package com.superpagesapp

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * Cuts the square the user framed in the profile-picture cropper out of an
 * image and scales it to the final size, as a JPEG. Everything stays in
 * memory (base64 in, base64 out): no decoded copy of the photo is written
 * anywhere.
 */
class ImageCropModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ImageCrop"

  private val worker = Executors.newSingleThreadExecutor()

  /** Crops the square at ([x], [y]) of side [size] (source pixels) and scales it to [out]×[out]. */
  @ReactMethod
  fun crop(base64: String, x: Double, y: Double, size: Double, out: Int, promise: Promise) {
    worker.execute {
      var src: Bitmap? = null
      var result: Bitmap? = null
      try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalArgumentException("Couldn't read that image.")
        val side = size.toInt().coerceIn(1, minOf(src.width, src.height))
        val left = x.toInt().coerceIn(0, src.width - side)
        val top = y.toInt().coerceIn(0, src.height - side)
        result = Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(result)
        val paint = android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(src, Rect(left, top, left + side, top + side), Rect(0, 0, out, out), paint)
        val jpeg = ByteArrayOutputStream()
        result.compress(Bitmap.CompressFormat.JPEG, 85, jpeg)
        promise.resolve(Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP))
      } catch (e: OutOfMemoryError) {
        promise.reject("E_CROP", "That image is too large.")
      } catch (e: Exception) {
        promise.reject("E_CROP", e.message ?: "Couldn't crop that image.", e)
      } finally {
        src?.recycle()
        result?.recycle()
      }
    }
  }
}
