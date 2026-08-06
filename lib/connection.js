const sql = require("mssql");

const pools = new Map();

const poolKey = (cfg) =>
  JSON.stringify([
    cfg.server,
    cfg.port || 1433,
    cfg.database,
    cfg.user,
    cfg.password,
    !!cfg.encrypt,
    !!cfg.trustServerCertificate,
  ]);

const toDriverConfig = (cfg) => ({
  server: cfg.server,
  port: cfg.port ? parseInt(cfg.port, 10) : 1433,
  database: cfg.database,
  user: cfg.user,
  password: cfg.password,
  options: {
    encrypt: !!cfg.encrypt,
    trustServerCertificate: !!cfg.trustServerCertificate,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
});

const getPool = async (cfg) => {
  const key = poolKey(cfg);
  const existing = pools.get(key);
  if (existing) {
    try {
      return await existing;
    } catch (e) {
      // a failed connect, should not be in the cache
      pools.delete(key);
      throw e;
    }
  }
  const p = new sql.ConnectionPool(toDriverConfig(cfg)).connect();
  pools.set(key, p);
  try {
    return await p;
  } catch (e) {
    console.error(
      `Failed to connect to SQL Server: ${describeConnError(cfg, e)}`,
    );
    pools.delete(key);
    throw new Error(describeConnError(cfg, e), { cause: e });
  }
};

/**
 * Turn a driver error into something that identifies the misconfiguration.
 */
const describeConnError = (cfg, e) => {
  const where = `${cfg.server || "(no server)"}:${cfg.port || 1433}/${
    cfg.database || "(no database)"
  }`;
  console.log({
    where,
    cfg,
    e: JSON.stringify(e, null, 2),
  });
  const code = e && e.code ? e.code : "unknown error";
  const detail = (e && (e.originalError?.message || e.message)) || "";
  if (code === "ELOGIN") {
    const pw =
      typeof cfg.password !== "string"
        ? "no password was supplied"
        : cfg.password.length === 0
          ? "the password is empty"
          : "the password is non-empty";
    return (
      `${detail} Check the user and password in ` +
      `the table's provider configuration`
    );
  }
  if (/self[- ]signed|certificate/i.test(detail))
    return (
      `${detail} (connecting to ${where}). Enable "Trust server certificate" ` +
      `in the provider configuration, or turn off "Encrypt connection".`
    );
  if (code === "ESOCKET" || code === "ETIMEOUT")
    return (
      `${detail} (could not reach ${where}). Check the server and port, and ` +
      `whether the database is running.`
    );
  return `${code}: ${detail} (connecting to ${where})`;
};

let log_sql_enabled = false;
const set_sql_logging = (val = true) => {
  log_sql_enabled = val;
};
const sql_log = (text, values) => {
  if (log_sql_enabled) console.log(text, values);
};

/**
 * Run a query, binding values as @p1, @p2, ... in push order - matching the
 * placeholders the dialect emits.
 *
 * @param {object} cfg - provider configuration
 * @param {string} text - SQL with @pN placeholders
 * @param {Array} [values] - values in placeholder order
 * @returns {Promise<object>} the driver result ({ recordset, rowsAffected })
 */
const query = async (cfg, text, values = []) => {
  const pool = await getPool(cfg);
  const request = pool.request();
  values.forEach((v, ix) => request.input(`p${ix + 1}`, v));
  sql_log(text, values);
  return await request.query(text);
};

/** Rows only - the common case. */
const rows = async (cfg, text, values = []) =>
  (await query(cfg, text, values)).recordset;

/** Close every cached pool. Used by tests and on plugin teardown. */
const closeAll = async () => {
  const ps = [...pools.values()];
  pools.clear();
  await Promise.all(
    ps.map((p) =>
      Promise.resolve(p)
        .then((pool) => pool.close())
        .catch(() => {}),
    ),
  );
};

module.exports = { getPool, query, rows, closeAll, set_sql_logging, sql_log };
