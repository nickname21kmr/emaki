-- 排队状态（P2 变更传播，docs/core-architecture.md 第 5.2 节）：要交给后台任务、还没做完的工作，重启不丢。
-- kind 是工作的种类（现在只有 'dedupe'：可见性或文件内容变了，要重新查重）；requested_at 是最近一次标记的时间，
-- 任务开始之后又有新标记的不清掉（只清 requested_at 不晚于任务开始时间的）。
CREATE TABLE pending_work (
  kind TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL
);
