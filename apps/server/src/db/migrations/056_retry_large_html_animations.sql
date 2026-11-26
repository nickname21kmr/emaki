-- 大的 HTML 动图重新读一次（2026-11-26）：以前整段动画超过 6400 万像素就记成「HTML 动图解码尺寸过大」拒收，
-- 文件没变之前扫描不再重试。现在分段编码、上限放宽（services/image/htmlAnimation.ts），删掉这些记录，下次扫描照常读进来
DELETE FROM scan_errors WHERE error = 'HTML 动图解码尺寸过大';
