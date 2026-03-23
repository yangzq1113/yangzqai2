package com.luker.app

import android.content.Context
import android.util.Base64
import java.util.Locale

object LukerHttpAuthStore {
    private const val PREFS_NAME = "luker_http_auth"

    data class Credentials(
        val username: String,
        val password: String,
    )

    fun load(context: Context, host: String, realm: String?): Credentials? {
        val key = buildKey(host, realm)
        val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val username = preferences.getString("${key}_username", null) ?: return null
        val password = preferences.getString("${key}_password", null) ?: return null
        return Credentials(username = username, password = password)
    }

    fun save(context: Context, host: String, realm: String?, credentials: Credentials) {
        val key = buildKey(host, realm)
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("${key}_username", credentials.username)
            .putString("${key}_password", credentials.password)
            .apply()
    }

    fun clear(context: Context, host: String, realm: String?) {
        val key = buildKey(host, realm)
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove("${key}_username")
            .remove("${key}_password")
            .apply()
    }

    private fun buildKey(host: String, realm: String?): String {
        val normalizedHost = host.trim().lowercase(Locale.ROOT)
        val normalizedRealm = realm?.trim().orEmpty()
        val rawKey = "$normalizedHost\n$normalizedRealm"
        return Base64.encodeToString(
            rawKey.toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP or Base64.URL_SAFE,
        )
    }
}
