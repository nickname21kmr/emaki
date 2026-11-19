/**
 * 模糊策略：「能否不打码显示」只有一套判断，在 packages/shared（blurReason，附录 #30），这里只是转出来给组件用。
 * 场合（browse / book / showcase）决定「分级还不可信」和「轻微」怎么处理，原因写在 shared 的 BlurContext 上。
 * 偏好（开关、范围、照片、文字）是本机偏好，见 lib/stores.ts 的 useBlurPrefs。
 */
export {
  blurLabel,
  blurReason,
  shouldBlur,
  showcaseQuery,
  type BlurContext,
  type BlurLevel,
  type BlurPrefs,
  type BlurReason,
  type BlurSubject,
} from '@emaki/shared';
