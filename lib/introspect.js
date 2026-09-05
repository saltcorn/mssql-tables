const { rows } = require("./connection");

/**
 * Map a SQL Server DATA_TYPE onto a Saltcorn type name.
 * @param {string} dataType - INFORMATION_SCHEMA.COLUMNS.DATA_TYPE
 * @returns {string|null}
 */
const sqlTypeToSaltcornType = (dataType) => {
  switch ((dataType || "").toLowerCase()) {
    case "int":
    case "smallint":
    case "tinyint":
    case "bigint":
      return "Integer";
    case "bit":
      return "Bool";
    case "decimal":
    case "numeric":
    case "float":
    case "real":
    case "money":
    case "smallmoney":
      return "Float";
    case "date":
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return "Date";
    case "char":
    case "varchar":
    case "nchar":
    case "nvarchar":
    case "text":
    case "ntext":
    case "uniqueidentifier":
    case "xml":
    case "time":
      return "String";
    default:
      return null;
  }
};

const COLUMNS_SQL = `
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH,
       COLUMNPROPERTY(
         OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)),
         COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
       COLUMNPROPERTY(
         OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)),
         COLUMN_NAME, 'IsComputed') AS IS_COMPUTED
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2
ORDER BY ORDINAL_POSITION`;

const PK_SQL = `
SELECT kcu.COLUMN_NAME
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
 AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  AND tc.TABLE_SCHEMA = @p1 AND tc.TABLE_NAME = @p2
ORDER BY kcu.ORDINAL_POSITION`;

const TABLES_SQL = `
SELECT TABLE_SCHEMA, TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW')
ORDER BY TABLE_SCHEMA, TABLE_NAME`;

/** "schema.table" strings for the configuration workflow's table picker. */
const listTables = async (cfg) => {
  console.log({ cfg });
  const rs = await rows(cfg, TABLES_SQL);
  return rs.map((r) => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`);
};

/** Split the configured "schema.table" into its parts, defaulting to dbo. */
const splitTableName = (table_name) => {
  if (!table_name) return null;
  const ix = table_name.indexOf(".");
  return ix === -1
    ? { schema: "dbo", table: table_name }
    : {
        schema: table_name.slice(0, ix),
        table: table_name.slice(ix + 1),
      };
};

/**
 * Build the raw column metadata for a configured table.
 *
 * @returns {Promise<{columns: Array, pk: Array<string>}>}
 */
const describeTable = async (cfg) => {
  const parts = splitTableName(cfg.table_name);
  if (!parts) return { columns: [], pk: [] };
  const [cols, pks] = await Promise.all([
    rows(cfg, COLUMNS_SQL, [parts.schema, parts.table]),
    rows(cfg, PK_SQL, [parts.schema, parts.table]),
  ]);
  return {
    columns: cols.map((c) => ({
      name: c.COLUMN_NAME,
      data_type: c.DATA_TYPE,
      nullable: c.IS_NULLABLE === "YES",
      max_length: c.CHARACTER_MAXIMUM_LENGTH,
      // identity and computed columns cannot be written to
      readonly: c.IS_IDENTITY === 1 || c.IS_COMPUTED === 1,
      identity: c.IS_IDENTITY === 1,
    })),
    pk: pks.map((r) => r.COLUMN_NAME),
  };
};

/**
 * Turn column metadata into Saltcorn FieldLike definitions.
 *
 * Exactly one field must carry primary_key so the external-table wrapper can
 * resolve pk_name; when the remote table declares a composite key every part
 * is marked and the wrapper picks up composite_pk_names. A table with no
 * primary key at all needs cfg.pk_column to nominate one.
 *
 * Pure, so it is unit-testable without a database.
 *
 * @param {{columns: Array, pk: Array<string>}} described
 * @param {object} [cfg]
 * @returns {Array} Saltcorn field definitions
 */
const columnsToFields = (described, cfg = {}) => {
  const { columns, pk } = described;
  const pkNames = pk && pk.length ? pk : cfg.pk_column ? [cfg.pk_column] : [];
  return columns
    .map((c) => {
      const type = sqlTypeToSaltcornType(c.data_type);
      if (!type) return null;
      return {
        name: c.name,
        label: c.name,
        type,
        primary_key: pkNames.includes(c.name),
        required: !c.nullable && !c.readonly,
        calculated: c.readonly,
        attributes: c.max_length > 0 ? { max_length: c.max_length } : {},
      };
    })
    .filter(Boolean);
};

// fields() is called for every Table.find(), so introspection is cached.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
const cacheKey = (cfg) =>
  JSON.stringify([cfg.server, cfg.port, cfg.database, cfg.table_name]);

const invalidate = (cfg) => {
  if (cfg) cache.delete(cacheKey(cfg));
  else cache.clear();
};

/**
 * Cached field list for a configured table.
 */
const fieldsForConfig = async (cfg) => {
  if (!cfg || !cfg.table_name || !cfg.server) return [];
  const key = cacheKey(cfg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.fields;
  try {
    const fields = columnsToFields(await describeTable(cfg), cfg);
    cache.set(key, { time: Date.now(), fields });
    return fields;
  } catch (e) {
    console.error(
      `mssql-tables: could not read schema for ${cfg.table_name}: ${e.message}`,
    );
    return [];
  }
};

module.exports = {
  sqlTypeToSaltcornType,
  columnsToFields,
  describeTable,
  fieldsForConfig,
  listTables,
  splitTableName,
  invalidate,
};
