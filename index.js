const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const {
  fieldsForConfig,
  listTables,
  describeTable,
  invalidate, // maybe use it latet in workflow's onDone
} = require("./lib/introspect");
const { get_table } = require("./lib/provider");
const { set_sql_logging } = require("./lib/connection");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Connection",
        form: async () =>
          new Form({
            fields: [
              {
                name: "server",
                label: "Server",
                sublabel: "Hostname or IP of the SQL Server instance",
                type: "String",
                required: true,
              },
              {
                name: "port",
                label: "Port",
                type: "Integer",
                default: 1433,
              },
              {
                name: "database",
                label: "Database",
                type: "String",
                required: true,
              },
              { name: "user", label: "User", type: "String" },
              {
                name: "password",
                label: "Password",
                type: "String",
                input_type: "password",
              },
              {
                name: "encrypt",
                label: "Encrypt connection",
                type: "Bool",
                default: true,
              },
              {
                name: "trustServerCertificate",
                label: "Trust server certificate",
                sublabel: "Enable for self-signed certificates",
                type: "Bool",
              },
            ],
          }),
      },
      {
        name: "Table",
        form: async (context) => {
          let options = [];
          let err = null;
          try {
            options = await listTables(context);
          } catch (e) {
            err = e.message;
          }
          return new Form({
            fields: [
              {
                name: "table_name",
                label: "Table",
                sublabel: err
                  ? `Could not list tables: ${err}. Enter schema.table manually.`
                  : "The SQL Server table or view to expose",
                type: "String",
                required: true,
                attributes: options.length ? { options } : {},
              },
            ],
          });
        },
      },
      {
        name: "Primary key",
        onlyWhen: async (context) => {
          try {
            const { pk } = await describeTable(context);
            return !pk.length;
          } catch (e) {
            return false;
          }
        },
        form: async (context) => {
          let options = [];
          try {
            const { columns } = await describeTable(context);
            options = columns.map((c) => c.name);
          } catch (e) {
            /* fall back to free text */
          }
          return new Form({
            fields: [
              {
                name: "pk_column",
                label: "Primary key column",
                sublabel:
                  "This table declares no primary key. Choose a column that " +
                  "uniquely identifies a row.",
                type: "String",
                required: true,
                attributes: options.length ? { options } : {},
              },
            ],
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "mssql-tables",
  table_providers: {
    "MS SQL Server": {
      configuration_workflow,
      fields: async (cfg) => await fieldsForConfig(cfg),
      get_table,
    },
  },
  set_sql_logging,
};
