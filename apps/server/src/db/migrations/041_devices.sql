-- 手机端 N 阶段（docs/mobile.md 第 2 节）：设备与访问。两张表的主人都是 access/（单一写入者测试）。
--
-- lan_access：局域网入口的配置，只有一行。server_id 是这台电脑的固定标识（mDNS 广播、hello、二维码里都用它，App 按它认电脑），
-- 第一次读的时候生成；enabled 默认关；port 默认 5175；name 是自己改的电脑名称，NULL 用计算机名。
CREATE TABLE lan_access (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  port INTEGER NOT NULL DEFAULT 5175,
  name TEXT
);

-- devices：批准过的设备。凭证只存 sha256（hex）；scopes 是 JSON 数组（命令注册表的 scope）。
-- 撤销只写 revoked_at、不删行：审计记录里的 device:<id> 还要显示名字，被撤销的凭证要能回 device_revoked。
-- 批准后 5 分钟内手机没取走凭证的，这一行直接删掉（凭证从来没用过）。
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  scopes TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_address TEXT,
  revoked_at TEXT
);
