package app.emaki.mobile.core

import java.net.URLDecoder

/**
 * 电脑上「用二维码添加」的内容（apps/server/src/access/access.ts 的 createTicket）：
 * `emaki://pair?id=<电脑标识>&fp=<证书指纹 hex>&p=<端口>&h=<地址1,地址2>&t=<一次性口令>`。
 * 扫码等于已经在电脑上同意了：带口令请求直接批准；指纹来自二维码，连上的电脑证书对不上就拒绝。
 */
data class PairTicket(
    val serverId: String,
    val fingerprint: ByteArray,
    val port: Int,
    val hosts: List<String>,
    val ticket: String,
) {
    val addresses: List<HostPort> get() = hosts.map { HostPort(it, port) }

    override fun equals(other: Any?): Boolean =
        other is PairTicket && serverId == other.serverId && fingerprint.contentEquals(other.fingerprint) &&
            port == other.port && hosts == other.hosts && ticket == other.ticket

    override fun hashCode(): Int = serverId.hashCode() * 31 + ticket.hashCode()

    companion object {
        /** 不是 Emaki 的二维码、缺了哪一项时返回 null */
        fun parse(text: String): PairTicket? {
            val s = text.trim()
            val prefix = "emaki://pair?"
            if (!s.startsWith(prefix, ignoreCase = true)) return null
            val query = s.substring(prefix.length).substringBefore('#')
            val params = HashMap<String, String>()
            for (pair in query.split('&')) {
                if (pair.isEmpty()) continue
                val k = pair.substringBefore('=')
                val v = if (pair.contains('=')) pair.substringAfter('=') else ""
                val decoded = runCatching { URLDecoder.decode(v, "UTF-8") }.getOrNull() ?: return null
                params[k] = decoded
            }
            val id = params["id"]?.takeIf { it.isNotBlank() } ?: return null
            val fp = params["fp"]?.let(Hex::decodeOrNull)?.takeIf { it.size == 32 } ?: return null
            val port = params["p"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            val hosts = params["h"].orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct()
            if (hosts.isEmpty()) return null
            val ticket = params["t"]?.takeIf { it.isNotBlank() } ?: return null
            return PairTicket(id, fp, port, hosts, ticket)
        }
    }
}
