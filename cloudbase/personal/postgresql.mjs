import { check } from "./private-files.mjs";
import { same } from "./spec.mjs";

// Fixed catalog query only: no customer SQL, identifiers or credentials.
// ExecutePGSql has write capability in CAM; the transport must allow only this
// exact payload for inspection. pgdoc is installed by the platform, never DDL.
export const PGDOC_PROBE_SQL = `SELECT CASE
  WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgdoc')
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgdoc') THEN 'ready'
  WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname IN ('pgdoc', 'pgdoc_core'))
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgdoc') THEN 'missing'
  ELSE 'partial'
END AS pgdoc_state`;

export async function inspectPostgreSQL(api, env, spec) {
  const instances = env.PostgreSQL;
  check(
    Array.isArray(instances) &&
      instances.length === 1 &&
      typeof instances[0].InstanceName === "string" &&
      instances[0].InstanceName.length > 0 &&
      typeof instances[0].Name === "string" &&
      instances[0].Name.length > 0 &&
      instances[0].Region === spec.region,
    "POSTGRESQL_NOT_CONFIRMED",
  );
  // Status is an integer in EnvInfo, without a documented enum. Do not invent
  // its meaning; verify actual SQL connectivity instead of assuming Status=1.
  const response = await api("tcb", "ExecutePGSql", {
    EnvId: spec.envId,
    Sql: PGDOC_PROBE_SQL,
  });
  check(
    same(response.Columns, ["pgdoc_state"]) &&
      Array.isArray(response.Rows) &&
      response.Rows.length === 1,
    "INVALID_POSTGRESQL_RESULT",
  );
  let row;
  try {
    row = JSON.parse(response.Rows[0]);
  } catch {
    throw new Error("INVALID_POSTGRESQL_RESULT");
  }
  check(
    Array.isArray(row) &&
      row.length === 1 &&
      ["ready", "missing", "partial"].includes(row[0]),
    "INVALID_POSTGRESQL_RESULT",
  );
  check(row[0] !== "partial", "PGDOC_PARTIAL_INSTALLATION");
  check(
    env.Databases == null || Array.isArray(env.Databases),
    "INVALID_POSTGRESQL_RESULT",
  );
  // Official enablement can clear an existing FlexDB database. Never automate
  // that migration, even when the customer authorized ordinary resource creation.
  check(
    row[0] === "ready" || !env.Databases?.length,
    "PGDOC_LEGACY_DATABASE_CONFLICT",
  );
  return {
    type: "postgresql",
    document_api: "pgdoc",
    plugin: row[0],
    sql_connectivity: "verified",
  };
}
