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
