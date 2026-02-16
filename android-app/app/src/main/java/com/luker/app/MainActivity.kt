package com.luker.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var loadingOverlay: View
    private lateinit var loadingText: TextView
    private val handler = Handler(Looper.getMainLooper())

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
            val result = LukerRuntimeManager.startIfNeeded(applicationContext)
            if (!result.ok) {
                runOnUiThread {
                    loadingText.text = getString(R.string.loading_failed)
                }
                return@Thread
            }

            runOnUiThread { loadingText.setText(R.string.loading_webview) }
            waitUntilServerReady(60, 750)
        }.start()
    }

    private fun waitUntilServerReady(maxAttempts: Int, delayMs: Long) {
        fun check(remaining: Int) {
            if (remaining <= 0) {
                loadingText.text = getString(R.string.loading_failed)
                return
            }

            if (LukerRuntimeManager.isServerReady()) {
                webView.loadUrl(LukerRuntimeManager.SERVER_URL)
                return
            }

            handler.postDelayed({ check(remaining - 1) }, delayMs)
        }
        check(maxAttempts)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
