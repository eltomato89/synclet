package tech.jensk.synclet.core.events

/** SYNC_API §5a: 1 s → 60 s exponential with ±20 % jitter; maximum after 404/429/non-SSE/too_many_streams; none after 401. */
class ReconnectPolicy(
    private val initialMs: Long = 1_000,
    private val maxMs: Long = 60_000,
    private val jitter: Double = 0.2,
    val healthyAfterMs: Long = 60_000,
    private val random: () -> Double = Math::random,
) {
    fun delayMs(reason: Disconnect, attempt: Int): Long? {
        val base = when (reason) {
            Disconnect.Unauthorized -> return null
            is Disconnect.Http -> when (reason.status) {
                401 -> return null
                404, 429 -> maxMs
                else -> exponential(attempt)
            }
            Disconnect.NotEventStream -> maxMs
            is Disconnect.Bye -> if (reason.reason == "too_many_streams") maxMs else exponential(attempt)
            Disconnect.Network, Disconnect.Closed -> exponential(attempt)
        }
        val jittered = (base * (1.0 + jitter * (2.0 * random() - 1.0))).toLong().coerceIn(0, maxMs)
        val retryAfter = ((reason as? Disconnect.Http)?.retryAfterSeconds ?: 0L) * 1_000
        return maxOf(jittered, retryAfter)
    }

    private fun exponential(attempt: Int): Long = minOf(maxMs, initialMs shl attempt.coerceIn(0, 16))
}
