/**
 * 手机访问的写操作（命令 access.configure、devices.*）。都不可撤销、也不占撤销栈（注册表里 undoable: false, barrier: false），
 * 所以 useMutate 带 undo: false；结果照常出一条墨色 toast。之后由 SSE 的 access 事件（断着时按命令，lib/events.ts 的 BY_COMMAND）重新取状态。
 */
import type { AccessStatus, MutationResult, Scope } from '@emaki/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api, withMeta, type AlbumSyncChanges } from '@/lib/api';
import { qk, useMutate } from '@/lib/queries';

const done = (r: { message: string }): MutationResult => withMeta({ ok: true, message: r.message, undoToken: null }, r);

/** 失败了（请求过期、设备已经被移除……）：以服务端为准重新取 */
function useRefetchOnError() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: qk.access });
}

/** 打开 / 关闭、改端口、改电脑名称：开关先改本地缓存（不等网络），响应里带回新的状态直接放进缓存 */
export function useConfigureAccess() {
  const client = useQueryClient();
  const refetch = useRefetchOnError();
  const m = useMutate(
    (body: { enabled?: boolean; port?: number; name?: string | null }) =>
      api.configureAccess(body).then((r) => {
        client.setQueryData<AccessStatus | null>(qk.access, r.status);
        return done(r);
      }),
    { undo: false },
  );
  return {
    ...m,
    configure: (body: { enabled?: boolean; port?: number; name?: string | null }) => {
      const enabled = body.enabled;
      // 开关不等网络；关掉时监听状态一起清掉
      if (enabled !== undefined)
        client.setQueryData<AccessStatus | null>(qk.access, (s) =>
          s ? { ...s, enabled, ...(enabled ? {} : { listening: false, error: null }) } : s,
        );
      m.mutate(body, { onError: refetch });
    },
  };
}

/** 批准一个请求：scopes 不给是默认权限 */
export function useApproveRequest() {
  const refetch = useRefetchOnError();
  const m = useMutate((v: { id: string; scopes?: Scope[] }) => api.approveDevice(v.id, v.scopes ? { scopes: v.scopes } : {}).then(done), {
    undo: false,
  });
  const approve = (id: string, scopes?: Scope[], onSuccess?: () => void) => m.mutate({ id, scopes }, { onError: refetch, onSuccess });
  return { ...m, approve };
}

export function useRejectRequest() {
  const refetch = useRefetchOnError();
  const m = useMutate((id: string) => api.rejectDevice(id).then(done), { undo: false });
  return { ...m, reject: (id: string, onSuccess?: () => void) => m.mutate(id, { onError: refetch, onSuccess }) };
}

/** 改设备的名称、权限 */
export function useUpdateDevice() {
  const refetch = useRefetchOnError();
  type Patch = { id: string; name?: string; scopes?: Scope[] };
  const m = useMutate((v: Patch) => api.updateDevice(v.id, { name: v.name, scopes: v.scopes }).then(done), { undo: false });
  const update = (v: Patch, onSuccess?: () => void) => m.mutate(v, { onError: refetch, onSuccess });
  return { ...m, update };
}

/** 移除设备：它立即断开 */
export function useRevokeDevice() {
  const refetch = useRefetchOnError();
  const m = useMutate((id: string) => api.revokeDevice(id).then(done), { undo: false });
  return { ...m, revoke: (id: string, onSuccess?: () => void) => m.mutate(id, { onError: refetch, onSuccess }) };
}

/** 改一台设备传上来的图放到哪（rootId 为 null 恢复默认）；不可撤销（之后上传的才按新的） */
export function useSetDeviceUpload() {
  const client = useQueryClient();
  type Body = { id: string; rootId: string | null; dir?: string };
  const m = useMutate((v: Body) => api.setDeviceUpload(v.id, { rootId: v.rootId, dir: v.dir }).then(done), { undo: false });
  const save = (v: Body, onSuccess?: () => void) =>
    m.mutate(v, { onSuccess, onSettled: () => void client.invalidateQueries({ queryKey: qk.uploadTargets }) });
  return { ...m, save };
}

/** 撤销从手机传上来的一批：新入库的图移到回收站。可撤销（toast 上的「撤销」把图拿回来） */
export function useUndoUploadBatch() {
  const client = useQueryClient();
  const m = useMutate((id: string) => api.undoUploadBatch(id), { label: '撤销这一批上传' });
  return {
    ...m,
    undoBatch: (id: string) => m.mutate(id, { onSettled: () => void client.invalidateQueries({ queryKey: qk.uploadBatches }) }),
  };
}

/**
 * 改同步相册（deviceId 不给是这台设备自己的）：回来的新状态直接放进缓存。不可撤销（App 下次同步时按新的）。
 * 在 App 里改的，改完让 App 马上同步一次（顺便按新的条件安排后台同步）
 */
export function useSetAlbums(deviceId?: string, after?: () => void) {
  const client = useQueryClient();
  const m = useMutate(
    (v: AlbumSyncChanges) =>
      api.setAlbums({ ...v, deviceId }).then((r) => {
        client.setQueryData(qk.albumSync(deviceId), r.info);
        return done(r);
      }),
    { undo: false, onSuccess: () => after?.() },
  );
  return { ...m, save: (v: AlbumSyncChanges, onSuccess?: () => void) => m.mutate(v, { onSuccess }) };
}
