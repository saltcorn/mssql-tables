const TRUE_RE = /(?<!["\w])TRUE(?![\w"])/g;
const FALSE_RE = /(?<!["\w])FALSE(?![\w"])/g;
// the ilike wrapper, as emitted by whereClause and by the join-field variant
const CONCAT_RE = /'%'\s*\|\|\s*(@p\d+)\s*\|\|\s*'%'/g;

/**
 * @param {string} where - a where clause from mkWhereForDialect
 * @returns {string} the same clause, valid on SQL Server
 */
const fixupTSql = (where) =>
  (where || "")
    .replace(CONCAT_RE, "CONCAT('%', $1, '%')")
    .replace(TRUE_RE, "(1 = 1)")
    .replace(FALSE_RE, "(1 = 0)");

module.exports = { fixupTSql };
