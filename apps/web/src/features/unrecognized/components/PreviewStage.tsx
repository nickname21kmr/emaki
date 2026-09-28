import type { ID, UnrecognizedItem } from '@emaki/shared';
import { Eye } from 'lucide-react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { useState } from 'react';
import { Thumb } from '@/components/media/Thumb';
import { Kbd } from '@/components/ui';
import { shouldBlur } from '@/lib/blur';
import { useBlurPrefs } from '@/lib/stores';
import { fitContain, useElementSize } from '../hooks';
import type { Direction } from '../types';
import { EASE_OUT } from '@/lib/motion';

const EASE = EASE_OUT;

// 前进从右边滑入、后退从左边滑入；幅度很小，只是给眼睛一个方向感
const slide: Variants = {
  enter: (d: Direction) => ({ opacity: 0, x: d * 36, scale: 0.985 }),
  center: { opacity: 1, x: 0, scale: 1, transition: { duration: 0.42, ease: EASE } },
  exit: (d: Direction) => ({ opacity: 0, x: d * -36, scale: 0.985, transition: { duration: 0.24, ease: EASE } }),
};

/** 预览区四周留白：左右各 32，上下各 44（底部放快捷键提示） */
const PAD_X = 64;
const PAD_Y = 88;

/**
 * 当前图片的大预览：放在一块下沉的「画框底」上，
 * 背后铺一层同图的大半径模糊当氛围光，图片本身按比例完整显示。
 */
export function PreviewStage({
  item,
  direction,
  onOpen,
}: {
  item: UnrecognizedItem;
  direction: Direction;
  onOpen: () => void;
}) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const { image } = item;
  const fit = fitContain(image.width, image.height, box.width - PAD_X, box.height - PAD_Y);

  // 「显示」只对当前这张生效，换图自动失效
  const [revealedId, setRevealedId] = useState<ID | null>(null);
  const blurPrefs = useBlurPrefs(); // 必须无条件调用（RV-A-2）
  const revealed = revealedId === image.id;
  const blurred = !revealed && shouldBlur(image, blurPrefs);

  return (
    <div
      ref={boxRef}
      className="relative min-h-0 flex-1 overflow-hidden rounded-[20px] bg-sunken shadow-[inset_0_0_0_1px_var(--c-line)]"
    >
      {/* 氛围光：同一张图的大模糊，跟着换图交叉淡入 */}
      <AnimatePresence initial={false}>
        <motion.div
          key={image.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.7, ease: EASE } }}
          exit={{ opacity: 0, transition: { duration: 0.5 } }}
          className="absolute inset-0"
          aria-hidden
        >
          <div className="absolute inset-0 opacity-40 dark:opacity-25">
            <Thumb
              image={image}
              width={240}
              className="absolute inset-0"
              // 氛围光自带 64px 重模糊，不走 Thumb 的模糊（RV-A-3）
              revealed
              imgClassName="scale-125 blur-3xl saturate-150"
            />
          </div>
        </motion.div>
      </AnimatePresence>

      <AnimatePresence initial={false} custom={direction}>
        <motion.div
          key={image.id}
          custom={direction}
          variants={slide}
          initial="enter"
          animate="center"
          exit="exit"
          className="absolute inset-0 flex items-center justify-center"
        >
          {fit.width > 0 && (
            <div className="relative" style={{ width: fit.width, height: fit.height }}>
              <button
                onClick={onOpen}
                aria-label={`查看大图：${image.fileName}`}
                className="block size-full cursor-zoom-in overflow-hidden rounded-[12px] shadow-pop ring-1 ring-line"
              >
                <Thumb image={image} width={960} eager revealed={revealed} className="size-full" />
              </button>
              {blurred && (
                <button
                  onClick={() => setRevealedId(image.id)}
                  className="absolute bottom-4 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/40 px-3.5 text-[12.5px] font-medium text-white ring-1 ring-white/15 backdrop-blur-md transition-colors hover:bg-black/55"
                >
                  <Eye className="size-3.5" />
                  显示这张
                </button>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-x-0 bottom-3.5 flex justify-center">
        <span className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
          <Kbd>空格</Kbd>查看大图
        </span>
      </div>
    </div>
  );
}
