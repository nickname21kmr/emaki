import type { CSSProperties } from 'react';

/** 朱色细光：配 animate-shimmer，和命令面板的 SearchProgress 同一个写法（运行中的页眉线、胶囊底边） */
export const SHU_GLINT: CSSProperties = {
  backgroundImage: 'linear-gradient(90deg, transparent, var(--c-shu), transparent)',
  backgroundSize: '40% 100%',
  backgroundRepeat: 'no-repeat',
};
