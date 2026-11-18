package app.emaki.mobile.platform

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import app.emaki.mobile.core.HostPort
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** 局域网里找到的一台电脑（mDNS 的 TXT：id、name、addr、v） */
data class FoundServer(val serverId: String, val name: String, val address: HostPort, val protocol: Int?)

/**
 * 在局域网里找电脑（docs/mobile.md 2.2）：NsdManager 搜 `_emaki._tcp`，按 TXT 的 id 去重，显示 TXT 的 name。
 * 地址优先用 TXT 的 addr（电脑按网卡分别广播，addr 就是手机所在这块网卡上电脑的地址，apps/server/src/access/discovery.ts），
 * 没有再用解析出来的主机地址。
 *
 * 模拟器在 NAT 后面，收不到局域网的 mDNS：这部分只能在真机上验证。
 */
class Discovery(context: Context) {
    private val nsd = context.applicationContext.getSystemService(NsdManager::class.java)

    /** 一直搜，每次有变化给出现在找到的全部电脑（按名称排）。收集结束时停止搜索 */
    fun browse(): Flow<List<FoundServer>> = callbackFlow {
        // 服务实例名 → 解析结果
        val found = LinkedHashMap<String, FoundServer>()
        // 找到、消失都排进一个队列，在一个协程里按顺序处理（老版本的 NsdManager 同时只能解析一个）
        val events = Channel<Pair<Boolean, NsdServiceInfo>>(Channel.UNLIMITED)

        fun publish() {
            // 同一台电脑（id）只留一条
            val byId = LinkedHashMap<String, FoundServer>()
            for (s in found.values) byId[s.serverId] = s
            trySend(byId.values.sortedBy { it.name })
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "开始搜索失败：$errorCode")
                trySend(emptyList())
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                events.trySend(true to info)
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                events.trySend(false to info)
            }
        }

        launch {
            for ((up, info) in events) {
                if (up) {
                    found[info.serviceName] = resolve(info) ?: continue
                } else if (found.remove(info.serviceName) == null) {
                    continue
                }
                publish()
            }
        }
        trySend(emptyList())
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        awaitClose {
            events.close()
            runCatching { nsd.stopServiceDiscovery(listener) }
        }
    }

    /** 按电脑标识找，找到就返回它的地址（调用方自己限时） */
    suspend fun find(serverId: String): HostPort? =
        browse().mapNotNull { list -> list.firstOrNull { it.serverId == serverId }?.address }.first()

    @Suppress("DEPRECATION")
    private suspend fun resolve(info: NsdServiceInfo): FoundServer? = suspendCancellableCoroutine { cont ->
        nsd.resolveService(
            info,
            object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    Log.w(TAG, "解析 ${serviceInfo.serviceName} 失败：$errorCode")
                    if (cont.isActive) cont.resume(null)
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    if (cont.isActive) cont.resume(parse(serviceInfo))
                }
            },
        )
    }

    private fun parse(info: NsdServiceInfo): FoundServer? {
        val txt = info.attributes.mapValues { (_, v) -> v?.toString(Charsets.UTF_8).orEmpty() }
        val id = txt["id"]?.takeIf { it.isNotBlank() } ?: return null
        @Suppress("DEPRECATION")
        val host = txt["addr"]?.takeIf { it.isNotBlank() } ?: info.host?.hostAddress ?: return null
        val name = txt["name"]?.takeIf { it.isNotBlank() } ?: info.serviceName
        return FoundServer(id, name, HostPort(host.substringBefore('%'), info.port), txt["v"]?.toIntOrNull())
    }

    private companion object {
        const val TAG = "EmakiDiscovery"
        const val SERVICE_TYPE = "_emaki._tcp"
    }
}
