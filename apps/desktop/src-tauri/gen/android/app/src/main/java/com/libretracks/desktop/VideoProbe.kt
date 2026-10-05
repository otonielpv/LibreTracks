package com.libretracks.desktop

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import org.json.JSONObject

/**
 * Analysis and thumbnails of a video without libmpv (plan video-mobile, paso
 * 07), called from Rust over JNI (src/platform/android_video.rs) on a worker
 * thread. Blocking on purpose: MediaMetadataRetriever and MediaExtractor are
 * fine off the main thread, and the caller is the thumbnail worker or an async
 * import, never the UI.
 *
 * `probe` answers JSON that `libretracks_video::media::parse_native_probe`
 * reads; rotation is reported, not applied (Rust applies it). `frames` answers
 * one JPEG per time, null where the decoder gave nothing.
 *
 * Kept from R8 in proguard-rules.pro: Rust calls it by name.
 */
object VideoProbe {
  private const val TAG = "LTVideoProbe"
  private const val JPEG_QUALITY = 72

  private fun setSource(retriever: MediaMetadataRetriever, context: Context, path: String) {
    if (path.startsWith("content://")) {
      retriever.setDataSource(context, Uri.parse(path))
    } else {
      retriever.setDataSource(path.removePrefix("file://"))
    }
  }

  private fun setSource(extractor: MediaExtractor, context: Context, path: String) {
    if (path.startsWith("content://")) {
      extractor.setDataSource(context, Uri.parse(path), null)
    } else {
      extractor.setDataSource(File(path.removePrefix("file://")).absolutePath)
    }
  }

  /** The provider's display name of a picked document ("ensayo.mp4"); the
   *  photo picker's URIs carry only a number. Null when it gives none. */
  @JvmStatic
  fun displayName(context: Context, uri: String): String? = try {
    context.contentResolver
      .query(Uri.parse(uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
  } catch (error: Exception) {
    Log.w(TAG, "display name of $uri: ${error.message}")
    null
  }

  @JvmStatic
  fun probe(context: Context, path: String): String {
    val out = JSONObject()
    val retriever = MediaMetadataRetriever()
    try {
      setSource(retriever, context, path)
      fun meta(key: Int): String? = retriever.extractMetadata(key)
      out.put(
        "durationSeconds",
        (meta(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000.0,
      )
      out.put("width", meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0)
      out.put("height", meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0)
      out.put(
        "rotationDegrees",
        meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0,
      )
      out.put("hasAudio", meta(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes")
      meta(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull()?.let {
        out.put("fps", it)
      }
    } catch (error: Exception) {
      out.put("error", error.message ?: error.javaClass.simpleName)
      return out.toString()
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }

    // The video track's format: codec, frame rate and whether this device
    // has a decoder for it at all (ProRes, 10-bit HEVC on a low-end phone).
    val extractor = MediaExtractor()
    try {
      setSource(extractor, context, path)
      for (index in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(index)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (!mime.startsWith("video/")) continue
        out.put("codec", mime.removePrefix("video/"))
        if (!out.has("fps") && format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
          format.getNumber(MediaFormat.KEY_FRAME_RATE)?.let { out.put("fps", it.toDouble()) }
        }
        // findDecoderForFormat must not see a frame rate on old Android.
        val query = MediaFormat(format)
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.LOLLIPOP) {
          query.setString(MediaFormat.KEY_FRAME_RATE, null)
        }
        val decoder = MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(query)
        out.put("decodable", decoder != null)
        out.put(
          "hardwareDecode",
          decoder != null &&
            !decoder.startsWith("OMX.google.") &&
            !decoder.startsWith("c2.android."),
        )
        break
      }
    } catch (error: Exception) {
      Log.w(TAG, "extractor: ${error.message}")
    } finally {
      extractor.release()
    }
    return out.toString()
  }

  @JvmStatic
  fun frames(context: Context, path: String, times: DoubleArray, width: Int): Array<ByteArray?> {
    val out = arrayOfNulls<ByteArray>(times.size)
    val retriever = MediaMetadataRetriever()
    try {
      setSource(retriever, context, path)
      val sourceWidth =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val sourceHeight =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      val rotation =
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      val (shownWidth, shownHeight) =
        if (rotation % 180 != 0) sourceHeight to sourceWidth else sourceWidth to sourceHeight
      val height =
        if (shownWidth > 0) (width.toLong() * shownHeight / shownWidth).toInt().coerceAtLeast(2) else width * 9 / 16
      for (index in times.indices) {
        val micros = (times[index] * 1_000_000).toLong()
        // CLOSEST_SYNC: a thumbnail does not need the exact frame, and a
        // keyframe decodes without the frames before it (paso 07 §2).
        val bitmap: Bitmap? = try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            retriever.getScaledFrameAtTime(micros, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, width, height)
          } else {
            retriever.getFrameAtTime(micros, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let {
              Bitmap.createScaledBitmap(it, width, height, true).also { scaled ->
                if (scaled !== it) it.recycle()
              }
            }
          }
        } catch (error: Exception) {
          Log.w(TAG, "frame at ${times[index]}s: ${error.message}")
          null
        }
        if (bitmap != null) {
          val bytes = ByteArrayOutputStream()
          bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, bytes)
          bitmap.recycle()
          out[index] = bytes.toByteArray()
        }
      }
    } catch (error: Exception) {
      Log.w(TAG, "frames of $path: ${error.message}")
    } finally {
      try {
        retriever.release()
      } catch (_: Exception) {
      }
    }
    return out
  }
}
