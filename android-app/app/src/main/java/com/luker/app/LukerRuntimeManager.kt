package com.luker.app

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.lang.Exception
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

object LukerRuntimeManager {
    private const val TAG = "LukerRuntime"
    private const val DEFAULT_SERVER_PORT = 8000
    private const val MAX_PORT_PROBE_ATTEMPTS = 50
    private val started = AtomicBoolean(false)
    private val librariesLoaded = AtomicBoolean(false)
    private const val RUNTIME_LAYOUT_VERSION = "2"
    private const val RUNTIME_MARKER = ".runtime-version"
    private const val RUNTIME_DIR_NAME = "luker-runtime"
    private const val PERSISTENT_DATA_DIR_NAME = "luker-data"
    private const val RUNTIME_PERSIST_DIR_NAME = "_runtime-persist"
    private const val NODE_SCRIPT_PATH = "nodejs-project/bootstrap.js"
    private const val NODE_PROJECT_ASSET_PATH = "luker"
    private const val BOOTSTRAP_LOG_FILE = "bootstrap.log"
    private val RUNTIME_PERSIST_RELATIVE_PATHS = listOf(
        "plugins",
        "public/scripts/extensions/third-party",
        "config.yaml",
        "whitelist.txt",
    )

    @Volatile
    private var serverPort: Int = DEFAULT_SERVER_PORT
    val SERVER_URL: String
        get() = "http://127.0.0.1:$serverPort"

    @Volatile
    private var runtimeDir: File? = null
    @Volatile
    private var dataRootDir: File? = null
    @Volatile
    private var pingFailures: Int = 0

    data class StartResult(val ok: Boolean, val error: String? = null)
    private data class RuntimePaths(val runtimeRoot: File, val dataRoot: File)

    @JvmStatic
    external fun startNodeWithArguments(arguments: Array<String>): Int
    @JvmStatic
    external fun isNodeProcessRunning(): Boolean

    private fun ensureLibrariesLoaded(): StartResult {
        if (librariesLoaded.get()) {
            return StartResult(ok = true)
        }
        synchronized(this) {
            if (librariesLoaded.get()) {
                return StartResult(ok = true)
            }
            return try {
                System.loadLibrary("node")
                System.loadLibrary("native-lib")
                librariesLoaded.set(true)
                StartResult(ok = true)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to load native libraries", t)
                StartResult(ok = false, error = "Native runtime load failed: ${t.message}")
            }
        }
    }

    fun startIfNeeded(context: Context): StartResult {
        val libLoadResult = ensureLibrariesLoaded()
        if (!libLoadResult.ok) {
            return libLoadResult
        }

        if (started.get() && !isNodeProcessRunning()) {
            Log.w(TAG, "Node process was marked started but is not running. Resetting start state.")
            started.set(false)
        }

        if (started.get()) {
            return StartResult(ok = true)
        }

        synchronized(this) {
            if (started.get()) {
                return StartResult(ok = true)
            }

            return try {
                val paths = prepareRuntime(context)
                runtimeDir = paths.runtimeRoot
                dataRootDir = paths.dataRoot
                val selectedPort = selectServerPort(DEFAULT_SERVER_PORT, MAX_PORT_PROBE_ATTEMPTS)
                serverPort = selectedPort

                val script = File(paths.runtimeRoot, "bootstrap.js")
                val args = arrayOf(
                    "node",
                    script.absolutePath,
                    "--port",
                    selectedPort.toString(),
                    "--dataRoot",
                    paths.dataRoot.absolutePath,
                )
                val exitCode = startNodeWithArguments(args)
                if (exitCode != 0) {
                    Log.e(TAG, "startNodeWithArguments returned non-zero: $exitCode")
                    return StartResult(ok = false, error = "Node process exited with code $exitCode")
                }
                started.set(true)
                Log.i(TAG, "Node runtime launch requested on port=$selectedPort. running=${isNodeProcessRunning()}")
                StartResult(ok = true)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to start runtime", t)
                StartResult(ok = false, error = t.message)
            }
        }
    }

    private fun selectServerPort(basePort: Int, maxAttempts: Int): Int {
        for (offset in 0 until maxAttempts) {
            val candidate = basePort + offset
            if (isPortAvailable(candidate)) {
                return candidate
            }
        }
        throw IllegalStateException("No available port in range $basePort..${basePort + maxAttempts - 1}")
    }

    private fun isPortAvailable(port: Int): Boolean {
        return try {
            ServerSocket().use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress("127.0.0.1", port))
            }
            true
        } catch (_: Throwable) {
            false
        }
    }

    private fun prepareRuntime(context: Context): RuntimePaths {
        val runtimeRoot = File(context.filesDir, RUNTIME_DIR_NAME)
        val dataRoot = File(context.filesDir, PERSISTENT_DATA_DIR_NAME)
        val persistRoot = File(dataRoot, RUNTIME_PERSIST_DIR_NAME)
        val markerFile = File(runtimeRoot, RUNTIME_MARKER)
        val legacyDataRoot = File(runtimeRoot, "data")
        migrateLegacyDataRoot(legacyDataRoot, dataRoot)
        if (!dataRoot.exists()) {
            dataRoot.mkdirs()
        }

        val markerValue = buildRuntimeMarker(context)
        val needsRefresh = !runtimeRoot.exists() || !markerFile.exists() || markerFile.readText() != markerValue

        if (needsRefresh) {
            if (runtimeRoot.exists()) {
                persistRuntimeArtifacts(runtimeRoot, persistRoot)
                runtimeRoot.deleteRecursively()
            }
            runtimeRoot.mkdirs()
            copyAssetDirectory(context.assets, NODE_PROJECT_ASSET_PATH, runtimeRoot)
            copyAssetFile(context.assets, NODE_SCRIPT_PATH, File(runtimeRoot, "bootstrap.js"))
            restoreRuntimeArtifacts(persistRoot, runtimeRoot)
            markerFile.writeText(markerValue)
            Log.i(TAG, "Runtime assets prepared at ${runtimeRoot.absolutePath}")
        }

        return RuntimePaths(runtimeRoot = runtimeRoot, dataRoot = dataRoot)
    }

    private fun persistRuntimeArtifacts(runtimeRoot: File, persistRoot: File) {
        for (relativePath in RUNTIME_PERSIST_RELATIVE_PATHS) {
            val source = File(runtimeRoot, relativePath)
            val target = File(persistRoot, relativePath)

            try {
                if (!source.exists()) {
                    if (target.exists()) {
                        target.deleteRecursively()
                    }
                    continue
                }

                target.parentFile?.mkdirs()
                if (target.exists()) {
                    target.deleteRecursively()
                }

                if (source.isDirectory) {
                    source.copyRecursively(target, overwrite = true)
                } else {
                    source.copyTo(target, overwrite = true)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to persist runtime artifact: $relativePath", t)
            }
        }
    }

    private fun restoreRuntimeArtifacts(persistRoot: File, runtimeRoot: File) {
        if (!persistRoot.exists()) {
            return
        }

        for (relativePath in RUNTIME_PERSIST_RELATIVE_PATHS) {
            val source = File(persistRoot, relativePath)
            val target = File(runtimeRoot, relativePath)

            try {
                if (!source.exists()) {
                    continue
                }

                target.parentFile?.mkdirs()
                if (target.exists()) {
                    target.deleteRecursively()
                }

                if (source.isDirectory) {
                    source.copyRecursively(target, overwrite = true)
                } else {
                    source.copyTo(target, overwrite = true)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to restore runtime artifact: $relativePath", t)
            }
        }
    }

    private fun migrateLegacyDataRoot(legacyDataRoot: File, dataRoot: File) {
        if (!legacyDataRoot.exists()) {
            return
        }

        if (dataRoot.exists()) {
            return
        }

        runCatching {
            dataRoot.parentFile?.mkdirs()
            if (legacyDataRoot.renameTo(dataRoot)) {
                Log.i(TAG, "Migrated legacy data root to ${dataRoot.absolutePath}")
                return
            }
            legacyDataRoot.copyRecursively(dataRoot, overwrite = false)
            legacyDataRoot.deleteRecursively()
            Log.i(TAG, "Copied legacy data root to ${dataRoot.absolutePath}")
        }.onFailure { t ->
            Log.e(TAG, "Failed to migrate legacy data root", t)
        }
    }

    private fun buildRuntimeMarker(context: Context): String {
        val lastUpdateTime = runCatching {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        }.getOrElse { 0L }
        return "layout=$RUNTIME_LAYOUT_VERSION;apkUpdatedAt=$lastUpdateTime"
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
            pingFailures = 0
            code in 200..499
        } catch (e: Exception) {
            pingFailures += 1
            if (started.get() && !isNodeProcessRunning()) {
                Log.w(TAG, "Node process is not running while server is unreachable. Resetting start state.")
                started.set(false)
            }
            if (pingFailures % 30 == 0) {
                val detail = e.message ?: e.javaClass.simpleName
                Log.w(TAG, "Server not ready after $pingFailures probes: $detail, nodeRunning=${isNodeProcessRunning()}")
            }
            false
        }
    }

    fun collectDiagnostics(context: Context, maxTailChars: Int = 6000): String {
        val dir = runtimeDir ?: File(context.filesDir, RUNTIME_DIR_NAME)
        val dataRoot = dataRootDir ?: File(context.filesDir, PERSISTENT_DATA_DIR_NAME)
        val marker = File(dir, RUNTIME_MARKER)
        val bootstrap = File(dir, "bootstrap.js")
        val logFile = File(dir, BOOTSTRAP_LOG_FILE)
        val sb = StringBuilder()
        sb.append("started=").append(started.get())
            .append(", nodeRunning=").append(
                try {
                    isNodeProcessRunning()
                } catch (_: Throwable) {
                    false
                }
            )
            .append(", runtimeDir=").append(dir.absolutePath)
            .append(", dataRoot=").append(dataRoot.absolutePath)
            .append('\n')
        sb.append("exists(runtimeDir)=").append(dir.exists())
            .append(", exists(dataRoot)=").append(dataRoot.exists())
            .append(", exists(marker)=").append(marker.exists())
            .append(", exists(bootstrap.js)=").append(bootstrap.exists())
            .append(", exists(bootstrap.log)=").append(logFile.exists())
            .append('\n')
        if (marker.exists()) {
            runCatching {
                sb.append("marker=").append(marker.readText()).append('\n')
            }
        }
        if (logFile.exists()) {
            sb.append("bootstrap.log tail:\n")
            sb.append(readTail(logFile, maxTailChars))
        } else {
            sb.append("bootstrap.log tail: <missing>")
        }
        return sb.toString()
    }

    private fun readTail(file: File, maxChars: Int): String {
        return runCatching {
            val text = file.readText(Charsets.UTF_8)
            if (text.length <= maxChars) text else text.takeLast(maxChars)
        }.getOrElse { t ->
            "<failed to read bootstrap.log: ${t.message}>"
        }
    }
}
