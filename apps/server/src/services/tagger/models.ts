/**
 * 打标签模型注册表。
 *
 * | 模型（HF 仓库）                         | model.onnx 字节数 | 官方 Macro-F1       | 定位                 |
 * |----------------------------------------|------------------|---------------------|----------------------|
 * | SmilingWolf/wd-eva02-large-tagger-v3   | 1,260,435,999    | 0.4772 @ 0.5296     | 默认，GPU 用          |
 * | SmilingWolf/wd-vit-large-tagger-v3     | 1,260,645,673    | 0.4674 @ 0.2606     | 体积一样但更差        |
 * | SmilingWolf/wd-swinv2-tagger-v3        |   467,460,978    | 0.4541 @ 0.2653     | CPU 回退时推荐        |
 * | SmilingWolf/wd-vit-tagger-v3           |   378,536,310    | 0.4402 @ 0.2614     | 最快、最弱            |
 *
 * - 四个 v3 共用同一份 selected_tags.csv：下标 0–3 rating，4–8109 general，8110–10860 character。
 * - v3 没有 copyright 输出，作品靠角色映射（T10、T11）。训练数据截至 2024-02-28。
 * - ONNX 图：输入 [batch_size, 448, 448, 3] NHWC float32，归一化在图里（直接喂 0–255 BGR）；
 *   结尾是 Sigmoid，输出已经是概率。
 *
 * 默认：PixAI Tagger v1.0（noaione 转的 ONNX，上游 pixai-labs/pixai-tagger-v1.0，Apache-2.0）
 * - 数据截至 2026-05，30,877 个标签（general 15,043 · character 8,308 · copyright 2,460 · style 4,917 · meta 145 · rating 4）；
 *   鸣潮、原神 5.x/6.x、星铁 3.x、绝区零的角色都在里面。WD v3 截至 2024-02，没有这些。
 * - 输入 [1, 3, 1008, 1008] NCHW RGB，等比缩放、黑边补齐，(x/255-0.5)/0.5；dynamo 导出，batch 固定为 1。
 * - 输出是 logits（没有 Sigmoid），标签表是 tags.json（按类别给 offset / count / tags）。
 * - 权重放在外部数据文件 model.onnx.data（1.96 GB），必须和 model.onnx 放在同一目录。
 */
export type PreprocessKind = 'wd-v3' | 'pixai' | 'pixai-v1';

export interface ModelFile {
  name: string;
  size: number;
  sha256: string;
}

export interface TaggerModelSpec {
  /** = Settings.tagger.model，也写进 images.tagger_model */
  repo: string;
  label: string;
  /** HF commit，固定版本，防止上游更新导致 sha 不符 */
  revision: string;
  preprocess: PreprocessKind;
  inputSize: number;
  /** null = session.outputNames[0] */
  outputName: string | null;
  /** freeDimensionOverrides 用的维度名 */
  batchDim: string;
  hasRating: boolean;
  /** 8GB 显存下的安全上限 */
  maxDmlBatch: number;
  /** 模型本身只接受这么大的 batch（dynamo 导出的固定 batch）；null = 不限 */
  maxBatch: number | null;
  /** 标签表格式：WD 的 selected_tags.csv / PixAI v1 的 tags.json */
  labelsFormat: 'csv' | 'pixai-json';
  /** 输出是 logits（要自己过 Sigmoid）还是已经是概率 */
  logits: boolean;
  /** 设置里选 GPU 时用哪个后端：WD 系列用 DirectML；PixAI v1 在 DirectML 上加载不了，用 WebGPU（RTX 3070 约 1.6 秒/张） */
  gpu: 'dml' | 'webgpu';
  /** data = ONNX 外部权重文件（和 model.onnx 同目录） */
  files: { model: ModelFile; labels: ModelFile; data?: ModelFile };
  /** ModelScope 上的同内容镜像（第三方 fork，靠 sha256 保证一致） */
  modelscopeRepo: string | null;
}

const WD_V3_LABELS: ModelFile = {
  name: 'selected_tags.csv',
  size: 308468,
  sha256: '298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217',
};

const wd = (name: string, revision: string, label: string, size: number, sha256: string, maxDmlBatch: number): TaggerModelSpec => ({
  repo: `SmilingWolf/${name}`,
  label,
  revision,
  preprocess: 'wd-v3',
  inputSize: 448,
  outputName: null,
  batchDim: 'batch_size',
  hasRating: true,
  maxDmlBatch,
  maxBatch: null,
  labelsFormat: 'csv',
  logits: false,
  gpu: 'dml',
  files: { model: { name: 'model.onnx', size, sha256 }, labels: WD_V3_LABELS },
  modelscopeRepo: `fireicewolf/${name}`,
});

const PIXAI_V1: TaggerModelSpec = {
  repo: 'noaione/pixai-tagger-v1.0-onnx',
  label: 'PixAI Tagger v1.0 fp32（角色截至 2026-05）',
  revision: '68e8f4f02dd56a5f40c1b7474489fa0f599dec34',
  preprocess: 'pixai-v1',
  inputSize: 1008,
  outputName: null,
  batchDim: 'batch',
  hasRating: true,
  maxDmlBatch: 1,
  maxBatch: 1,
  labelsFormat: 'pixai-json',
  logits: true,
  gpu: 'webgpu',
  files: {
    model: { name: 'model.onnx', size: 2633225, sha256: '563f4576c2668560c20f403b957f0ec4a7bd6a2275da2c2aa7f82f898ad34e5c' },
    data: { name: 'model.onnx.data', size: 1955123200, sha256: '4de1c25a38d1f2a2172fbcb0d2485b5f02a058b6e67bedd7bbbcfdf4de9329dc' },
    labels: { name: 'tags.json', size: 816539, sha256: '0d34f2078016798808dc066dc206b18fb6ce7622f64241002ecd24172a4da068' },
  },
  modelscopeRepo: null,
};

/** 同一模型的 fp16 版（A1yCE/pixai-tagger-v1.0-onnx-fp16）：0.98 GB，RTX 3070 上约 1.2 秒/张（fp32 约 1.6 秒），准确率相同 */
const PIXAI_V1_FP16: TaggerModelSpec = {
  ...PIXAI_V1,
  repo: 'A1yCE/pixai-tagger-v1.0-onnx-fp16',
  label: 'PixAI Tagger v1.0 fp16（默认，更快）',
  revision: 'main',
  files: {
    model: { name: 'model.onnx', size: 980020396, sha256: 'c5157c2037e71022a04e4a217af77400183dac34b7da1587727f3e089c087123' },
    labels: PIXAI_V1.files.labels,
  },
};

export const TAGGER_MODELS: TaggerModelSpec[] = [
  PIXAI_V1_FP16,
  PIXAI_V1,
  wd('wd-eva02-large-tagger-v3', 'b25b82a03f7282e41aa2f257a52c7583b710bd1c', 'WD EVA02-Large v3（旧默认，角色截至 2024-02）', 1260435999, '9e768793060c7939b277ccb382783e8670e8a042d29d77aa736be0c8cc898bfc', 16),
  wd('wd-vit-large-tagger-v3', 'ae469aa2e4706a3af08d3673cf73a11d1add314c', 'WD ViT-Large v3', 1260645673, 'e4c8001b000a6c98f2db10794f7c406daa79873d071d6ca924330fa053fa1845', 16),
  wd('wd-swinv2-tagger-v3', '627aef95638667ddcaa3ac8ae625e88ea5b02f51', 'WD SwinV2 v3（快，CPU 推荐）', 467460978, 'e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1', 32),
  wd('wd-vit-tagger-v3', '7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f', 'WD ViT v3（最快）', 378536310, '35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6', 32),
];

export const DEFAULT_TAGGER_MODEL = TAGGER_MODELS[0]!.repo;

/** 给设置页看的说明（角色数来自各自的标签表：PixAI v1 character 8,308 个，WD v3 character 2,751 个） */
export const MODEL_NOTES: Record<string, { characterCount: number; dataUntil: string; note: string }> = {
  'A1yCE/pixai-tagger-v1.0-onnx-fp16': {
    characterCount: 8308,
    dataUntil: '2026-05',
    note: '推荐。认得的角色最多，新角色也认得。用显卡时走 WebGPU，需要较新的显卡驱动',
  },
  'noaione/pixai-tagger-v1.0-onnx': {
    characterCount: 8308,
    dataUntil: '2026-05',
    note: '和上面同一个模型的完整精度版，结果一样，体积大一倍、更慢，一般不用选',
  },
  'SmilingWolf/wd-eva02-large-tagger-v3': {
    characterCount: 2751,
    dataUntil: '2024-02',
    note: '显卡驱动较旧、用不了 WebGPU 时选它，走 DirectML。认不出 2024 年以后的新角色',
  },
  'SmilingWolf/wd-vit-large-tagger-v3': {
    characterCount: 2751,
    dataUntil: '2024-02',
    note: '和 EVA02 一样大，但准确率略低，一般不用选',
  },
  'SmilingWolf/wd-swinv2-tagger-v3': {
    characterCount: 2751,
    dataUntil: '2024-02',
    note: '只有 CPU、没有可用显卡时推荐：体积小，速度快',
  },
  'SmilingWolf/wd-vit-tagger-v3': {
    characterCount: 2751,
    dataUntil: '2024-02',
    note: '最小最快，准确率最低，电脑很旧时再考虑',
  },
};

export const modelDownloadSize = (spec: TaggerModelSpec) =>
  spec.files.model.size + spec.files.labels.size + (spec.files.data?.size ?? 0);

export function findModel(repo: string): TaggerModelSpec | null {
  return TAGGER_MODELS.find((m) => m.repo === repo) ?? null;
}

/** CPU 上大 batch 没有收益；DML 按模型限制，防止爆显存 */
export function clampBatch(spec: TaggerModelSpec, device: 'cpu' | 'dml', requested: number): number {
  return Math.max(1, Math.min(requested, device === 'dml' ? spec.maxDmlBatch : 4, spec.maxBatch ?? Infinity));
}
