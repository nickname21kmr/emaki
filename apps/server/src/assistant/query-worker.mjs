import Database from 'better-sqlite3';
process.once('message', (workerData) => {
const reply = (data) => process.send(data, () => process.exit(0));
try {
  const db = new Database(workerData.file, { readonly: true, fileMustExist: true, timeout: 1000 });
  db.pragma('query_only = ON');
  db.pragma('trusted_schema = OFF');
  const sql = workerData.sql.trim();
  // No ATTACH, PRAGMA setters, transactions or extension loading. readonly is checked by SQLite too.
  if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(sql)) throw new Error('只支持 SELECT / WITH / EXPLAIN 只读查询');
  const statement = db.prepare(sql);
  if (!statement.reader || !statement.readonly) throw new Error('查询必须是只读语句');
  // settings 里存着凭据（secret.*）。按字节码判断：只要会打开它的表或索引就拒绝，视图、CTE、子查询都算。
  // EXPLAIN 本身不读表数据，不用再查。
  if (!/^EXPLAIN\b/i.test(sql)) {
    const hidden = new Set(db.prepare("SELECT rootpage FROM sqlite_schema WHERE tbl_name = 'settings' AND rootpage > 0").pluck().all());
    const program = db.prepare('EXPLAIN ' + sql).all(...workerData.params);
    if (program.some(op => (op.opcode === 'OpenRead' || op.opcode === 'ReopenIdx') && op.p3 === 0 && hidden.has(op.p2))) throw new Error('settings 表包含凭据，不能通过 SQL 读取');
  }
  statement.safeIntegers(true);
  const rows = []; let bytes = 0, truncated = false;
  for (const row of statement.iterate(...workerData.params)) {
    const normalized = JSON.parse(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v));
    bytes += Buffer.byteLength(JSON.stringify(normalized));
    if (rows.length >= workerData.limit || bytes > 1024 * 1024) { truncated = true; break; }
    rows.push(normalized);
  }
  const result = { columns: statement.columns().map(c => c.name), rows, truncated };
  db.close();
  reply(result);
} catch (error) { reply({ error: error.message }); }
});
