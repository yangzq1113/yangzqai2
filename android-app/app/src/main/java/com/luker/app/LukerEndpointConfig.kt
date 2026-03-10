package com.luker.app

import android.content.Context
import android.net.Uri

object LukerEndpointConfig {
    private const val PREFS_NAME = "luker_endpoint_config"
    private const val KEY_CUSTOM_BASE_URL = "custom_base_url"

    data class Selection(val customBaseUrl: String?) {
        val usesDefaultLocalRuntime: Boolean
            get() = customBaseUrl.isNullOrBlank()

        fun resolveBaseUrl(): String = customBaseUrl ?: LukerRuntimeManager.SERVER_URL
    }

    fun load(context: Context): Selection {
        val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val customBaseUrl = preferences.getString(KEY_CUSTOM_BASE_URL, null)?.trim()?.ifEmpty { null }
        return Selection(customBaseUrl = customBaseUrl)
    }

    fun saveCustom(context: Context, baseUrl: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CUSTOM_BASE_URL, baseUrl)
            .apply()
    }

    fun resetToDefault(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_CUSTOM_BASE_URL)
            .apply()
    }

    fun normalizeCustomBaseUrl(rawValue: String?): String? {
        val trimmed = rawValue?.trim()?.ifEmpty { null } ?: return null
        val parsed = Uri.parse(trimmed)
        val scheme = parsed.scheme?.lowercase()
        val host = parsed.host
        if ((scheme != "http" && scheme != "https") || host.isNullOrBlank()) {
            return null
        }
        if (!parsed.encodedQuery.isNullOrEmpty() || !parsed.encodedFragment.isNullOrEmpty()) {
            return null
        }
        return trimmed.trimEnd('/')
    }
}
