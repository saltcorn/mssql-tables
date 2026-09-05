const {
  mkWhereForDialect,
  sqlsanitize,
} = require("@saltcorn/db-common/internal");
const { mssqlDialect, quote } = require("./dialect");
const { mkSelectTail } = require("./select-tail");
const { fixupTSql } = require("./tsql-fixup");
// required as a namespace, not destructured, so tests can substitute the
// runner and assert on the SQL this module generates
const conn = require("./connection");
const { splitTableName } = require("./introspect");

/** Fully-qualified, quoted table name. */
const qTable = (cfg) => {
  const parts = splitTableName(cfg.table_name);
  if (!parts) throw new Error("mssql-tables: no table configured");
  return `${quote(sqlsanitize(parts.schema))}.${quote(sqlsanitize(parts.table))}`;
};

const where_and_values = (whereObj) => {
  const d = mssqlDialect();
  const { where, values } = mkWhereForDialect(whereObj, d);
  // db-common hardcodes a few fragments that no dialect hook covers
  return { where: fixupTSql(where), values, dialect: d };
};

/** Columns that can be written: excludes identity and computed columns. */
const writableFields = (tbl) =>
  (tbl && tbl.fields ? tbl.fields : []).filter((f) => !f.calculated);

const pkNames = (tbl) => {
  const fs = tbl && tbl.fields ? tbl.fields : [];
  const pks = fs.filter((f) => f.primary_key).map((f) => f.name);
  return pks;
};

/**
 * Aggregate names Saltcorn may ask for that we can express in SQL Server.
 * Anything else throws rather than silently returning a wrong number.
 */
const aggregateSql = (aggregate, colExpr) => {
  const agg = (aggregate || "count").toLowerCase();
  switch (agg) {
    case "count":
      return colExpr ? `COUNT(${colExpr})` : "COUNT(*)";
    case "countunique":
    case "count distinct":
      return `COUNT(DISTINCT ${colExpr})`;
    case "sum":
    case "avg":
    case "min":
    case "max":
      return `${agg.toUpperCase()}(${colExpr})`;
    default:
      throw new Error(
        `mssql-tables: aggregate "${aggregate}" is not supported against SQL Server`,
      );
  }
};

const get_table = (cfg, tbl) => ({
  // our rows come back already filtered, ordered and paged
  disableFiltering: true,

  async getRows(whereObj = {}, selopts = {}) {
    if (!cfg || !cfg.table_name) return [];
    const { where, values, dialect } = where_and_values(whereObj);
    const cols =
      selopts.fields && selopts.fields.length
        ? selopts.fields.map((f) => quote(sqlsanitize(f))).join(", ")
        : (tbl && tbl.fields ? tbl.fields : []).length
          ? tbl.fields.map((f) => quote(sqlsanitize(f.name))).join(", ")
          : "*";
    const tail = mkSelectTail(selopts, dialect, pkNames(tbl)[0]);
    const sql = `SELECT ${cols} FROM ${qTable(cfg)} ${where} ${tail}`;
    return await conn.rows(cfg, sql, values);
  },

  async countRows(whereObj = {}) {
    if (!cfg || !cfg.table_name) return 0;
    const { where, values } = where_and_values(whereObj);
    const sql = `SELECT COUNT(*) AS [count] FROM ${qTable(cfg)} ${where}`;
    const rs = await conn.rows(cfg, sql, values);
    return parseInt(String(rs[0].count), 10);
  },

  async insertRow(row) {
    const writable = writableFields(tbl).map((f) => f.name);
    const entries = Object.entries(row || {}).filter(
      ([k]) => !writable.length || writable.includes(k),
    );
    const pk = pkNames(tbl)[0];
    const output = pk ? ` OUTPUT INSERTED.${quote(sqlsanitize(pk))}` : "";

    let sql;
    let values = [];
    if (!entries.length) {
      sql = `INSERT INTO ${qTable(cfg)}${output} DEFAULT VALUES`;
    } else {
      const cols = entries.map(([k]) => quote(sqlsanitize(k))).join(", ");
      const phs = entries.map((_, ix) => `@p${ix + 1}`).join(", ");
      values = entries.map(([, v]) => v);
      sql = `INSERT INTO ${qTable(cfg)} (${cols})${output} VALUES (${phs})`;
    }
    const rs = await conn.rows(cfg, sql, values);
    return pk && rs.length ? rs[0][pk] : undefined;
  },

  async updateRow(row, id) {
    const writable = writableFields(tbl).map((f) => f.name);
    const entries = Object.entries(row || {}).filter(
      ([k]) => !writable.length || writable.includes(k),
    );
    if (!entries.length) return;

    const pks = pkNames(tbl);
    if (!pks.length)
      throw new Error(
        `mssql-tables: cannot update ${cfg.table_name} - it has no primary key`,
      );

    const sets = entries
      .map(([k], ix) => `${quote(sqlsanitize(k))} = @p${ix + 1}`)
      .join(", ");
    const values = entries.map(([, v]) => v);

    // id is a scalar for a single pk, or a row of pk values for a composite one
    let n = entries.length;
    const conds = pks.map((p) => {
      n += 1;
      values.push(id !== null && typeof id === "object" ? id[p] : id);
      return `${quote(sqlsanitize(p))} = @p${n}`;
    });

    const sql = `UPDATE ${qTable(cfg)} SET ${sets} WHERE ${conds.join(" AND ")}`;
    await conn.query(cfg, sql, values);
  },

  async deleteRows(whereObj = {}) {
    const { where, values } = where_and_values(whereObj);
    const sql = `DELETE FROM ${qTable(cfg)} ${where}`;
    await conn.query(cfg, sql, values);
  },

  async distinctValues(fldNm, whereObj) {
    const { where, values } = where_and_values(whereObj);
    const col = quote(sqlsanitize(fldNm));
    const sql = `SELECT DISTINCT ${col} FROM ${qTable(cfg)} ${where} ORDER BY ${col}`;
    const rs = await conn.rows(cfg, sql, values);
    return rs.map((r) => r[fldNm]);
  },

  async aggregationQuery(aggregations, options = {}) {
    const { where, values, dialect } = where_and_values(options.where);
    const groupBy = options.groupBy
      ? Array.isArray(options.groupBy)
        ? options.groupBy
        : [options.groupBy]
      : null;

    const selects = Object.entries(aggregations || {}).map(([nm, agg]) => {
      const colExpr = agg.field ? quote(sqlsanitize(agg.field)) : null;
      return `${aggregateSql(agg.aggregate, colExpr)} AS ${quote(sqlsanitize(nm))}`;
    });

    const groupCols = groupBy
      ? groupBy.map((g) => quote(sqlsanitize(g)))
      : null;
    if (groupCols) selects.unshift(...groupCols);

    const sql = [
      `SELECT ${selects.join(", ")} FROM ${qTable(cfg)}`,
      where,
      groupCols ? `GROUP BY ${groupCols.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const rs = await conn.rows(cfg, sql, values);
    return groupBy ? rs : rs[0] || {};
  },
});

module.exports = { get_table, qTable, aggregateSql };
