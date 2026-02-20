package com.luker.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.File
import java.io.IOException
import java.io.PrintWriter
import java.io.StringWriter

class MainActivity : AppCompatActivity() {
    private val tag = "LukerMainActivity"
    private val runtimeReportFileName = "luker-runtime-last-error.txt"
    private lateinit var webView: WebView
    private lateinit var loadingOverlay: View
    private lateinit var loadingText: TextView
    @Volatile
    private var runtimeFailureDialogShown: Boolean = false
    private var pendingFilePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingWebPermissionResources: Array<String>? = null
    private var pendingSaveBytes: ByteArray? = null
    private var pendingSaveMimeType: String? = null
    private var pendingSaveFileName: String? = null

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = pendingFilePathCallback ?: return@registerForActivityResult
        pendingFilePathCallback = null
        val chosenUris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        callback.onReceiveValue(chosenUris)
    }
    private val webPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val request = pendingWebPermissionRequest
        val resources = pendingWebPermissionResources
        pendingWebPermissionRequest = null
        pendingWebPermissionResources = null
        if (request == null || resources == null) {
            return@registerForActivityResult
        }

        val allowed = resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> grants[Manifest.permission.RECORD_AUDIO] == true
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> grants[Manifest.permission.CAMERA] == true
                else -> false
            }
        }

        if (allowed.isEmpty()) {
            request.deny()
        } else {
            request.grant(allowed.toTypedArray())
        }
    }
    private val saveFileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val bytes = pendingSaveBytes
        val mimeType = pendingSaveMimeType
        val fileName = pendingSaveFileName
        pendingSaveBytes = null
        pendingSaveMimeType = null
        pendingSaveFileName = null

        val targetUri = result.data?.data
        if (result.resultCode != RESULT_OK || targetUri == null || bytes == null) {
            return@registerForActivityResult
        }

        Thread {
            try {
                contentResolver.openOutputStream(targetUri, "w")?.use { output ->
                    output.write(bytes)
                    output.flush()
                } ?: throw IOException("Unable to open output stream: $targetUri")
                runOnUiThread {
                    Toast.makeText(this, getString(R.string.download_saved, fileName ?: "file"), Toast.LENGTH_SHORT).show()
                }
            } catch (t: Throwable) {
                Log.e(tag, "Failed to save downloaded file (mime=$mimeType): $targetUri", t)
                runOnUiThread {
                    Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }

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
        webView.addJavascriptInterface(LukerAndroidBridge(), "LukerAndroid")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                if (filePathCallback == null) {
                    return false
                }
                pendingFilePathCallback?.onReceiveValue(null)
                pendingFilePathCallback = filePathCallback

                val chooserIntent = try {
                    fileChooserParams?.createIntent()
                } catch (t: Throwable) {
                    Log.w(tag, "Failed to create file chooser intent", t)
                    null
                } ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (e: ActivityNotFoundException) {
                    pendingFilePathCallback = null
                    Log.e(tag, "No activity can handle file chooser intent", e)
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) {
                    return
                }
                val requestedResources = request.resources ?: emptyArray()
                if (requestedResources.isEmpty()) {
                    request.deny()
                    return
                }

                val requiredRuntimePermissions = requestedResources
                    .flatMap { resource ->
                        when (resource) {
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
                            else -> emptyList()
                        }
                    }
                    .distinct()

                if (requiredRuntimePermissions.isEmpty()) {
                    request.grant(requestedResources)
                    return
                }

                val allGranted = requiredRuntimePermissions.all { permission ->
                    ContextCompat.checkSelfPermission(this@MainActivity, permission) == PackageManager.PERMISSION_GRANTED
                }
                if (allGranted) {
                    request.grant(requestedResources)
                    return
                }

                pendingWebPermissionRequest?.deny()
                pendingWebPermissionRequest = request
                pendingWebPermissionResources = requestedResources
                webPermissionLauncher.launch(requiredRuntimePermissions.toTypedArray())
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest?) {
                if (pendingWebPermissionRequest == request) {
                    pendingWebPermissionRequest = null
                    pendingWebPermissionResources = null
                }
                super.onPermissionRequestCanceled(request)
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

            override fun onPageFinished(view: WebView?, url: String?) {
                installBlobDownloadBridge()
                loadingOverlay.visibility = View.GONE
            }
        }
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            enqueueDownload(url, userAgent, contentDisposition, mimeType)
        }

        bootstrapRuntime()
    }

    private inner class LukerAndroidBridge {
        @JavascriptInterface
        fun saveFileFromDataUrl(dataUrl: String?, suggestedName: String?, mimeType: String?) {
            if (dataUrl.isNullOrBlank()) {
                return
            }
            val parsed = parseDataUrl(dataUrl) ?: run {
                runOnUiThread { Toast.makeText(this@MainActivity, getString(R.string.download_failed), Toast.LENGTH_SHORT).show() }
                return
            }
            val resolvedName = sanitizeFileName(suggestedName).ifBlank { "download" }
            val resolvedMime = if (mimeType.isNullOrBlank()) parsed.first else mimeType
            runOnUiThread { requestSaveFile(parsed.second, resolvedName, resolvedMime) }
        }
    }

    private fun installBlobDownloadBridge() {
        val script = """
            (function () {
              if (window.__lukerAndroidDownloadBridgeInstalled) return;
              window.__lukerAndroidDownloadBridgeInstalled = true;
              if (!window.LukerAndroid || typeof window.LukerAndroid.saveFileFromDataUrl !== 'function') return;

              const toDataUrl = (blob) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });

              const handoffDownload = async (anchor) => {
                try {
                  const href = String(anchor.href || '');
                  if (!href.startsWith('blob:') && !href.startsWith('data:')) return false;
                  const fileName = anchor.getAttribute('download') || 'download';
                  let dataUrl = href;
                  let mime = anchor.type || 'application/octet-stream';

                  if (href.startsWith('blob:')) {
                    const response = await fetch(href);
                    const blob = await response.blob();
                    mime = blob.type || mime;
                    dataUrl = await toDataUrl(blob);
                  }

                  window.LukerAndroid.saveFileFromDataUrl(dataUrl, fileName, mime);
                  return true;
                } catch (error) {
                  console.error('[LukerAndroid] blob download handoff failed', error);
                  return false;
                }
              };

              const originalClick = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.click = function () {
                if (this && this.hasAttribute('download')) {
                  const href = String(this.href || '');
                  if (href.startsWith('blob:') || href.startsWith('data:')) {
                    handoffDownload(this);
                    return;
                  }
                }
                return originalClick.call(this);
              };
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    private fun enqueueDownload(
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        if (url.isNullOrBlank()) {
            return
        }
        val parsedUri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        val scheme = parsedUri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return
        }
        try {
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(fileName)
                setMimeType(mimeType)
                setDescription(getString(R.string.download_queued))
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                if (!userAgent.isNullOrBlank()) {
                    addRequestHeader("User-Agent", userAgent)
                }
                val cookies = CookieManager.getInstance().getCookie(url)
                if (!cookies.isNullOrBlank()) {
                    addRequestHeader("Cookie", cookies)
                }
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val manager = getSystemService(DownloadManager::class.java)
            manager.enqueue(request)
            Toast.makeText(this, getString(R.string.download_started), Toast.LENGTH_SHORT).show()
        } catch (t: Throwable) {
            Log.e(tag, "Failed to enqueue download: $url", t)
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
    }

    private fun requestSaveFile(bytes: ByteArray, fileName: String, mimeType: String) {
        if (pendingSaveBytes != null) {
            Toast.makeText(this, getString(R.string.download_in_progress), Toast.LENGTH_SHORT).show()
            return
        }
        pendingSaveBytes = bytes
        pendingSaveMimeType = mimeType
        pendingSaveFileName = fileName

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_TITLE, fileName)
        }
        try {
            saveFileLauncher.launch(intent)
        } catch (e: ActivityNotFoundException) {
            Log.e(tag, "No activity can handle file save intent", e)
            pendingSaveBytes = null
            pendingSaveMimeType = null
            pendingSaveFileName = null
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun parseDataUrl(dataUrl: String): Pair<String, ByteArray>? {
        if (!dataUrl.startsWith("data:", ignoreCase = true)) {
            return null
        }
        val separatorIndex = dataUrl.indexOf(',')
        if (separatorIndex <= 5) {
            return null
        }
        val metadata = dataUrl.substring(5, separatorIndex)
        val payload = dataUrl.substring(separatorIndex + 1)
        val mimeType = metadata.substringBefore(';').ifBlank { "application/octet-stream" }
        val bytes = try {
            if (metadata.contains(";base64", ignoreCase = true)) {
                Base64.decode(payload, Base64.DEFAULT)
            } else {
                Uri.decode(payload).toByteArray(Charsets.UTF_8)
            }
        } catch (t: Throwable) {
            Log.e(tag, "Failed to decode data URL payload", t)
            return null
        }
        return mimeType to bytes
    }

    private fun sanitizeFileName(input: String?): String {
        val fallback = "download"
        if (input.isNullOrBlank()) {
            return fallback
        }
        return input.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]"), "_").trim().ifBlank { fallback }
    }

    private fun bootstrapRuntime() {
        loadingText.setText(R.string.loading_runtime)

        Thread {
            try {
                val result = LukerRuntimeManager.startIfNeeded(applicationContext)
                if (!result.ok) {
                    val detail = result.error?.trim()?.takeIf { it.isNotEmpty() }
                    val diagnostics = collectRuntimeDiagnosticsSafe()
                    Log.e(tag, "Runtime start failed: ${detail ?: "unknown"}\n$diagnostics")
                    reportRuntimeFailure(detail ?: "unknown", diagnostics)
                    return@Thread
                }

                runOnUiThread { loadingText.setText(R.string.loading_webview) }
                waitUntilServerReady(240, 1000)
            } catch (t: Throwable) {
                Log.e(tag, "bootstrapRuntime crashed", t)
                val diagnostics = collectRuntimeDiagnosticsSafe()
                reportRuntimeFailure(t.message ?: "unknown error", diagnostics, t)
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
                reportRuntimeFailure("Node exited before startup completed", diagnostics)
                return
            }

            if (remaining <= 0) {
                val diagnostics = LukerRuntimeManager.collectDiagnostics(applicationContext)
                Log.e(tag, "Server readiness timed out.\n$diagnostics")
                reportRuntimeFailure(getString(R.string.loading_failed_timeout), diagnostics)
                return
            }

            remaining -= 1
            Thread.sleep(delayMs)
        }
    }

    private fun collectRuntimeDiagnosticsSafe(): String {
        return runCatching { LukerRuntimeManager.collectDiagnostics(applicationContext) }
            .getOrElse { t -> "diagnostics_unavailable: ${t.message ?: t.javaClass.simpleName}" }
    }

    private fun reportRuntimeFailure(
        reason: String,
        diagnostics: String,
        throwable: Throwable? = null,
    ) {
        val safeReason = reason.trim().ifEmpty { "unknown error" }
        val report = buildRuntimeFailureReport(safeReason, diagnostics, throwable)
        val reportFile = runCatching { persistRuntimeReport(report) }.getOrNull()

        runOnUiThread {
            loadingText.text = getString(R.string.loading_failed_with_reason, safeReason)
            if (runtimeFailureDialogShown) {
                return@runOnUiThread
            }
            runtimeFailureDialogShown = true
            showRuntimeFailureDialog(report, reportFile)
        }
    }

    private fun buildRuntimeFailureReport(
        reason: String,
        diagnostics: String,
        throwable: Throwable?,
    ): String {
        val throwableText = throwable?.let {
            val writer = StringWriter()
            PrintWriter(writer).use { printer ->
                throwable.printStackTrace(printer)
            }
            writer.toString().trim()
        }

        return buildString {
            append("reason=").append(reason).append('\n')
            append("server=").append(LukerRuntimeManager.SERVER_URL).append('\n')
            append("device=").append(android.os.Build.MANUFACTURER)
                .append(' ')
                .append(android.os.Build.MODEL)
                .append('\n')
            append("android=").append(android.os.Build.VERSION.RELEASE)
                .append(" (sdk=").append(android.os.Build.VERSION.SDK_INT).append(")\n")
            append("package=").append(packageName).append('\n')
            append("timestamp=").append(System.currentTimeMillis()).append('\n')
            if (!throwableText.isNullOrEmpty()) {
                append("\nstacktrace:\n").append(throwableText).append('\n')
            }
            append("\ndiagnostics:\n").append(diagnostics.trim())
        }
    }

    private fun persistRuntimeReport(report: String): File {
        val file = File(filesDir, runtimeReportFileName)
        file.writeText(report, Charsets.UTF_8)
        return file
    }

    private fun showRuntimeFailureDialog(report: String, reportFile: File?) {
        val reportView = TextView(this).apply {
            text = report
            setTextIsSelectable(true)
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(32, 24, 32, 24)
        }
        val scrollView = ScrollView(this).apply {
            addView(reportView)
        }

        val intro = buildString {
            append(getString(R.string.runtime_error_dialog_intro))
            if (reportFile != null) {
                append('\n').append(getString(R.string.runtime_error_report_saved, reportFile.absolutePath))
            }
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.runtime_error_dialog_title)
            .setMessage(intro)
            .setView(scrollView)
            .setPositiveButton(android.R.string.ok, null)
            .setNeutralButton(R.string.runtime_error_copy) { _, _ ->
                val clipboard = getSystemService(ClipboardManager::class.java)
                clipboard?.setPrimaryClip(ClipData.newPlainText("luker-runtime-error", report))
                Toast.makeText(this, getString(R.string.runtime_error_copy_done), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.runtime_error_share) { _, _ ->
                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "Luker runtime startup report")
                    putExtra(Intent.EXTRA_TEXT, report)
                }
                runCatching {
                    startActivity(Intent.createChooser(shareIntent, getString(R.string.runtime_error_share)))
                }
            }
            .setCancelable(false)
            .show()
    }

    override fun onDestroy() {
        pendingFilePathCallback?.onReceiveValue(null)
        pendingFilePathCallback = null
        pendingWebPermissionRequest?.deny()
        pendingWebPermissionRequest = null
        pendingWebPermissionResources = null
        pendingSaveBytes = null
        pendingSaveMimeType = null
        pendingSaveFileName = null
        super.onDestroy()
    }
}
