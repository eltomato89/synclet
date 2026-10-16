package tech.jensk.synclet.core.api

import kotlinx.serialization.json.Json

val SyncJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}
