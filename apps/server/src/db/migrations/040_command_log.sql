-- P6（docs/core-architecture.md 第 4.1、9 节，附录 #35）：命令层的审计记录和 operationId 幂等。
-- 每次执行写命令记一行：哪个命令、谁做的（actor：user / assistant / job:<任务> …）、结果那句话、撤销令牌、变了哪些事实。
-- 带 operationId 的（AI 助手的每次修改、网页带 Idempotency-Key 的请求）按 operation_key 去重：同一个键再来一次直接返回存下的结果，
-- 不重复执行；键相同、参数不同报冲突；上次进程中途退出、结果不确定的（interrupted）要求先查询实际状态。
-- 后台任务每跑完一轮也记一行（command 是 job:<任务>）。只留最近的一批（启动时清理，commands/audit.ts）。
CREATE TABLE command_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  command TEXT NOT NULL,
  actor TEXT NOT NULL,
  -- `<命名空间>:<operationId>`：助手按会话、网页按 user 分开，同一个 operationId 在不同调用方之间不冲突；没带是 NULL
  operation_key TEXT UNIQUE,
  -- 输入（校验、规范化之后）的 sha256：同一个 operationId 换了参数就是冲突
  signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'interrupted')),
  message TEXT,
  undo_token TEXT,
  -- 公开的变化类型（JSON 数组）
  changes TEXT,
  -- 带 operationId 的才存完整结果（重试时原样返回）
  result TEXT,
  error TEXT
);
CREATE INDEX idx_command_log_actor ON command_log (actor, id);
