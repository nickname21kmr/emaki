/**
 * DirectML 加载 PixAI v1 fp16 前的内存补丁。
 *
 * 模型里 341 个 Reshape 带 allowzero=1，目标形状里又有 -1；DirectML 不支持这个组合，建会话时报 80070057。
 * 这些形状里都没有 0（按 sha256 固定的这一个模型逐个核对过），allowzero=1 和 0 结果完全一样，
 * 所以直接把属性值从 1 改成 0。protobuf 里是 0A 09 "allowzero" 18 01，只改最后一个字节，长度不变。
 */
const ALLOWZERO_1 = Buffer.from([0x0a, 0x09, ...Buffer.from('allowzero'), 0x18, 0x01]);

/** 原地把 allowzero=1 改成 0，返回改了几处 */
export function clearReshapeAllowzero(model: Buffer): number {
  let n = 0;
  for (let at = model.indexOf(ALLOWZERO_1); at !== -1; at = model.indexOf(ALLOWZERO_1, at + ALLOWZERO_1.length)) {
    model[at + ALLOWZERO_1.length - 1] = 0;
    n++;
  }
  return n;
}
