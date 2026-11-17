package com.libretracks.desktop

import android.content.Intent
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Process
import android.util.Log
import android.view.KeyEvent
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import kotlin.system.exitProcess

/**
 * Keeps a dead WebView renderer from taking the whole app down as a crash.
 *
 * The UI runs in the WebView's renderer, a separate process. When it dies
 * (killed for memory, or out of memory itself), Chromium asks the
 * WebViewClient's `onRenderProcessGone`; wry's client does not answer, so
 * Chromium aborts OUR process too: "Render process crash wasn't handled by all
 * associated webviews, triggering application crash". A user adding songs to a
 * big setlist saw exactly that, labelled "closed because it ran out of memory"
 * (2026-11-17, reproduced on a Tab A7).
 *
 * A wry WebView cannot be rebuilt from Kotlin (Rust owns it), so the best
 * recovery is a clean restart: log the event to the error log, relaunch the
 * app if it is on screen, and exit. No crash dialog, and the next start opens
 * normally. A second death within [LOOP_WINDOW_MS] exits without relaunching,
 * so a session that kills the renderer on open cannot loop forever.
 *
 * wry sets its own `RustWebViewClient` right after `onWebViewCreate`, in the
 * same main-thread message, so [install] runs from a `post` and wraps it.
 * Every callback is forwarded; only `onRenderProcessGone` is ours.
 */
object RendererGoneGuard {
  private const val TAG = "LTRenderer"
  private const val PREFS = "lt_renderer_guard"
  private const val KEY_LAST_RESTART = "last_restart_ms"
  private const val LOOP_WINDOW_MS = 60_000L

  fun install(activity: AppCompatActivity, webView: WebView) {
    // getWebViewClient and onRenderProcessGone are both API 26.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    webView.post { wrap(activity, webView) }
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun wrap(activity: AppCompatActivity, webView: WebView) {
    val inner = webView.webViewClient
    if (inner is Forwarding) return
    webView.webViewClient = Forwarding(inner) { didCrash ->
      onGone(activity, webView, didCrash)
    }
  }

  private fun onGone(activity: AppCompatActivity, webView: WebView, didCrash: Boolean) {
    val prefs = activity.getSharedPreferences(PREFS, AppCompatActivity.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val lastRestart = prefs.getLong(KEY_LAST_RESTART, 0L)
    val onScreen = activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    val restart = onScreen && now - lastRestart > LOOP_WINDOW_MS
    Log.e(TAG, "renderer gone: crashed=$didCrash onScreen=$onScreen restart=$restart")
    try {
      nativeOnRendererGone(didCrash, restart)
    } catch (error: UnsatisfiedLinkError) {
      Log.w(TAG, "native library not loaded: ${error.message}")
    }
    // commit, not apply: the process ends a few lines below.
    prefs.edit().putLong(KEY_LAST_RESTART, now).commit()

    // The dead WebView must not be touched again.
    (webView.parent as? android.view.ViewGroup)?.removeView(webView)
    webView.destroy()

    if (restart) {
      activity.packageManager.getLaunchIntentForPackage(activity.packageName)?.let { intent ->
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity.startActivity(intent)
      }
    }
    activity.finishAffinity()
    Process.killProcess(Process.myPid())
    exitProcess(0)
  }

  @JvmStatic private external fun nativeOnRendererGone(didCrash: Boolean, restarting: Boolean)

  @RequiresApi(Build.VERSION_CODES.O)
  private class Forwarding(
    private val inner: WebViewClient,
    private val onGone: (Boolean) -> Unit,
  ) : WebViewClient() {
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
      onGone(detail.didCrash())
      return true
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
      inner.shouldInterceptRequest(view, request)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
      inner.shouldOverrideUrlLoading(view, request)

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
      inner.onPageStarted(view, url, favicon)

    override fun onPageFinished(view: WebView, url: String) = inner.onPageFinished(view, url)

    override fun onPageCommitVisible(view: WebView, url: String) = inner.onPageCommitVisible(view, url)

    override fun onLoadResource(view: WebView, url: String) = inner.onLoadResource(view, url)

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
      inner.onReceivedError(view, request, error)

    override fun onReceivedHttpError(
      view: WebView,
      request: WebResourceRequest,
      errorResponse: WebResourceResponse,
    ) = inner.onReceivedHttpError(view, request, errorResponse)

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
      inner.onReceivedSslError(view, handler, error)

    override fun onReceivedHttpAuthRequest(
      view: WebView,
      handler: HttpAuthHandler,
      host: String,
      realm: String,
    ) = inner.onReceivedHttpAuthRequest(view, handler, host, realm)

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
      inner.doUpdateVisitedHistory(view, url, isReload)

    override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean =
      inner.shouldOverrideKeyEvent(view, event)

    override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) = inner.onUnhandledKeyEvent(view, event)

    override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) =
      inner.onScaleChanged(view, oldScale, newScale)
  }
}
