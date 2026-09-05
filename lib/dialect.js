const {
  sqlsanitizeAllowDots,
  ftsFieldsSqlExpr,
} = require("@saltcorn/db-common/internal");

const quote = (s) =>
  s.includes(".")
    ? s.split(".").map(quote).join(".")
    : s.includes('"')
      ? s
      : `"${s}"`;

/**
 * @param {number} [init] - number of placeholders already bound, so a second
 *   stack continuing an existing query does not reuse @p names.
 * @returns {object} a SqlDialect
 */
const mssqlDialect = (init = 0) => {
  const values = [];
  let i = init;
  const push = (x) => {
    values.push(x);
    i += 1;
    return `@p${i}`;
  };

  return {
    name: "mssql",
    is_sqlite: false,
    push,
    getValues() {
      return values;
    },
    placeholderAt(n) {
      return `@p${n}`;
    },
    like() {
      return "LIKE";
    },
    regexOperator() {
      throw new Error(
        "SQL Server does not support regular expression matching in where clauses",
      );
    },
    castDateExpr(doCast, s) {
      return !doCast ? s : `CAST(${s} AS date)`;
    },
    jsonExtractExpr(fieldExpr, jsonPath, asText) {
      const p = jsonPath.replace(/'/g, "''");
      return asText
        ? `JSON_VALUE(${fieldExpr}, '${p}')`
        : `JSON_QUERY(${fieldExpr}, '${p}')`;
    },
    ftsWhereClause(v) {
      const { fields, table, schema } = v;
      const flds = ftsFieldsSqlExpr(fields, table, schema);
      return `${flds} LIKE CONCAT('%', ${push(v.searchTerm)}, '%')`;
    },
    arrayInClause(vals) {
      if (!vals.length) return `IN (SELECT NULL WHERE 1 = 0)`;
      return `IN (${vals.map((v) => push(v)).join(", ")})`;
    },
    slugifyWhereClause(k, s) {
      return `LOWER(REPLACE(${quote(sqlsanitizeAllowDots(k))}, ' ', '-')) = ${push(s)}`;
    },
    textCastSuffix() {
      return "";
    },
    randomOrderExpr() {
      return "NEWID()";
    },
  };
};

module.exports = { mssqlDialect, quote };
