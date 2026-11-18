package app.emaki.mobile.core

/** 电脑的一个地址：主机（IPv4、IPv6 或主机名）+ 端口 */
data class HostPort(val host: String, val port: Int) {
    /** URL 里的写法：IPv6 加方括号 */
    val authority: String get() = if (host.contains(':')) "[$host]:$port" else "$host:$port"

    fun url(path: String = "/"): String = "https://$authority$path"

    override fun toString(): String = authority
}

object Addresses {
    /** 局域网入口的默认端口（电脑上设置 →「手机访问」里可改） */
    const val DEFAULT_PORT = 5175

    /**
     * 手动输入的地址：`主机:端口`，端口默认 5175。也接受粘贴进来的 `https://主机:端口/…`、IPv6 的 `[::1]:5175`。
     * 写错了（空的、有空格、端口不是 1–65535）返回 null。
     */
    fun parse(input: String, defaultPort: Int = DEFAULT_PORT): HostPort? {
        var s = input.trim()
        if (s.isEmpty()) return null
        s = s.removePrefix("https://").removePrefix("http://")
        s = s.substringBefore('/').substringBefore('?').substringBefore('#')
        if (s.isEmpty() || s.any { it.isWhitespace() }) return null
        val host: String
        val portText: String?
        if (s.startsWith("[")) {
            val end = s.indexOf(']')
            if (end < 0) return null
            host = s.substring(1, end)
            val rest = s.substring(end + 1)
            portText = when {
                rest.isEmpty() -> null
                rest.startsWith(":") -> rest.substring(1)
                else -> return null
            }
        } else if (s.count { it == ':' } > 1) {
            // 没加方括号的 IPv6：整个当主机
            host = s
            portText = null
        } else {
            host = s.substringBefore(':')
            portText = if (s.contains(':')) s.substringAfter(':') else null
        }
        if (host.isEmpty()) return null
        val port = if (portText == null) defaultPort else portText.toIntOrNull() ?: return null
        if (port !in 1..65535) return null
        return HostPort(host, port)
    }

    /**
     * 之后每次打开时要试的地址（docs/mobile.md 2.4），按这个顺序、去掉重复的：
     * 1. 局域网里按电脑标识找到的（NSD）；
     * 2. 上次连上的；
     * 3. 电脑在 hello 里告诉过的其他地址（端口用 hello 给的端口）。
     */
    fun candidates(discovered: HostPort?, last: HostPort?, known: List<String>, knownPort: Int): List<HostPort> {
        val out = LinkedHashSet<HostPort>()
        discovered?.let(out::add)
        last?.let(out::add)
        for (h in known) {
            val host = h.trim()
            if (host.isNotEmpty()) out.add(HostPort(host, knownPort))
        }
        return out.toList()
    }
}
