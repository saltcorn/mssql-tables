const { sqlsanitizeAllowDots } = require("@saltcorn/db-common/internal");
const { quote } = require("./dialect");

const toInt = (x) =>
  typeof x === "number"
    ? Math.round(x)
    : typeof x === "string"
      ? parseInt(x, 10)
      : null;

/**
 * @param {object} selopts - Saltcorn SelectOptions
 * @param {object} dialect - the SqlDialect (for randomOrderExpr)
 * @param {string} [pkName] - fallback ordering column
 * @returns {string} the tail, or "" when nothing is needed
 */
const mkSelectTail = (selopts = {}, dialect, pkName) => {
  const { orderBy, orderDesc, nocase, limit, offset } = selopts;
  const desc = orderDesc ? " DESC" : "";

  let orderby = "";
  if (orderBy === "RANDOM()") {
    orderby = `ORDER BY ${dialect.randomOrderExpr()}`;
  } else if (orderBy && typeof orderBy === "object") {
    throw new Error(
      "SQL Server tables do not support distance or operator ordering",
    );
  } else if (orderBy && typeof orderBy === "string") {
    const col = quote(sqlsanitizeAllowDots(orderBy));
    orderby = nocase
      ? `ORDER BY LOWER(${col})${desc}`
      : `ORDER BY ${col}${desc}`;
  }

  const lim = limit ? toInt(limit) : null;
  const off = offset ? toInt(offset) : null;

  if (!lim && !off) return orderby;

  // paging needs some ordering to be deterministic - and to parse at all
  if (!orderby)
    orderby = pkName
      ? `ORDER BY ${quote(sqlsanitizeAllowDots(pkName))}`
      : `ORDER BY (SELECT NULL)`;

  const parts = [orderby, `OFFSET ${off || 0} ROWS`];
  if (lim) parts.push(`FETCH NEXT ${lim} ROWS ONLY`);
  return parts.join(" ");
};

module.exports = { mkSelectTail };
