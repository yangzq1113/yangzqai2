package com.luker.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private val tag = "LukerMainActivity"
    private lateinit var webView: WebView
    private lateinit var loadingOverlay: View
    private lateinit var loadingText: TextView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.lukerWebView)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        loadingText = findViewById(R.id.loadingText)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
        }
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

            override fun onPageFinished(view: WebView?, url: String?) {
                loadingOverlay.visibility = View.GONE
            }
        }

        bootstrapRuntime()
    }

    private fun bootstrapRuntime() {
        loadingText.setText(R.string.loading_runtime)

        Thread {
            try {
                val result = LukerRuntimeManager.startIfNeeded(applicationContext)
                if (!result.ok) {
                    runOnUiThread {
                        val detail = result.error?.trim()?.takeIf { it.isNotEmpty() }
                        Log.e(tag, "Runtime start failed: ${detail ?: "unknown"}")
                        loadingText.text = if (detail == null) {
                            getString(R.string.loading_failed)
                        } else {
                            getString(R.string.loading_failed_with_reason, detail)
                        }
                    }
                    return@Thread
                }

                runOnUiThread { loadingText.setText(R.string.loading_webview) }
                waitUntilServerReady(240, 1000)
            } catch (t: Throwable) {
                Log.e(tag, "bootstrapRuntime crashed", t)
                runOnUiThread {
                    loadingText.text = getString(
                        R.string.loading_failed_with_reason,
                        t.message ?: "unknown error",
                    )
                }
            }
        }.start()
    }

    private fun waitUntilServerReady(maxAttempts: Int, delayMs: Long) {
        var remaining = maxAttempts
        while (!isDestroyed && !isFinishing) {
            if (LukerRuntimeManager.isServerReady()) {
                runOnUiThread { webView.loadUrl(LukerRuntimeManager.SERVER_URL) }
                return
            }

            if (!LukerRuntimeManager.isNodeProcessRunning()) {
                val diagnostics = LukerRuntimeManager.collectDiagnostics(applicationContext)
                Log.e(tag, "Node runtime stopped before server became ready.\n$diagnostics")
                runOnUiThread {
                    loadingText.text = getString(
                        R.string.loading_failed_with_reason,
                        "Node exited before startup completed. Check Logcat tag: $tag",
                    )
                }
                return
            }

            if (remaining <= 0) {
                val diagnostics = LukerRuntimeManager.collectDiagnostics(applicationContext)
                Log.e(tag, "Server readiness timed out.\n$diagnostics")
                runOnUiThread {
                    loadingText.text = getString(R.string.loading_failed_timeout)
                }
                return
            }

            remaining -= 1
            Thread.sleep(delayMs)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
    }
}
