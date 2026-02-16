package com.luker.app

import android.content.Context
import android.content.res.AssetManager
import java.io.File
import java.io.FileOutputStream
import java.lang.Exception
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

object LukerRuntimeManager {
    private val started = AtomicBoolean(false)
    private const val VERSION = "0.1.0"
    private const val RUNTIME_MARKER = ".runtime-version"
    private const val NODE_SCRIPT_PATH = "nodejs-project/bootstrap.js"

    const val SERVER_URL = "http://127.0.0.1:8000"

    @Volatile
    private var runtimeDir: File? = null

    data class StartResult(val ok: Boolean, val error: String? = null)

    @JvmStatic
    external fun startNodeWithArguments(arguments: Array<String>): Int

    init {
        System.loadLibrary("node")
        System.loadLibrary("native-lib")
    }

    fun startIfNeeded(context: Context): StartResult {
        if (started.get()) {
            return StartResult(ok = true)
        }

        synchronized(this) {
            if (started.get()) {
                return StartResult(ok = true)
            }

            return try {
                val dir = prepareRuntime(context)
                runtimeDir = dir

                val script = File(dir, "bootstrap.js")
                val args = arrayOf("node", script.absolutePath)
                startNodeWithArguments(args)
                started.set(true)
                StartResult(ok = true)
            } catch (e: Exception) {
                StartResult(ok = false, error = e.message)
            }
        }
    }

    private fun prepareRuntime(context: Context): File {
        val runtimeRoot = File(context.filesDir, "luker-runtime")
        val markerFile = File(runtimeRoot, RUNTIME_MARKER)
        val needsRefresh = !runtimeRoot.exists() || !markerFile.exists() || markerFile.readText() != VERSION

        if (needsRefresh) {
            if (runtimeRoot.exists()) {
                runtimeRoot.deleteRecursively()
            }
            runtimeRoot.mkdirs()
            copyAssetDirectory(context.assets, "nodejs-project/luker", runtimeRoot)
            copyAssetFile(context.assets, NODE_SCRIPT_PATH, File(runtimeRoot, "bootstrap.js"))
            markerFile.writeText(VERSION)
        }

        val dataDir = File(runtimeRoot, "data")
        if (!dataDir.exists()) {
            dataDir.mkdirs()
        }

        return runtimeRoot
    }

    private fun copyAssetDirectory(assetManager: AssetManager, assetPath: String, targetDir: File) {
        val entries = assetManager.list(assetPath) ?: emptyArray()
        if (entries.isEmpty()) {
            copyAssetFile(assetManager, assetPath, targetDir)
            return
        }

        if (!targetDir.exists()) {
            targetDir.mkdirs()
        }

        for (entry in entries) {
            val childAssetPath = if (assetPath.isEmpty()) entry else "$assetPath/$entry"
            val childTarget = File(targetDir, entry)
            copyAssetDirectory(assetManager, childAssetPath, childTarget)
        }
    }

    private fun copyAssetFile(assetManager: AssetManager, assetPath: String, outFile: File) {
        outFile.parentFile?.mkdirs()
        assetManager.open(assetPath).use { input ->
            FileOutputStream(outFile).use { output ->
                input.copyTo(output)
            }
        }
    }

    fun isServerReady(): Boolean {
        return try {
            val url = URL("$SERVER_URL/api/ping")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 800
                readTimeout = 800
                doOutput = true
            }
            connection.outputStream.use { os -> os.write(ByteArray(0)) }
            val code = connection.responseCode
            connection.disconnect()
            code in 200..499
        } catch (_: Exception) {
            false
        }
    }
}
