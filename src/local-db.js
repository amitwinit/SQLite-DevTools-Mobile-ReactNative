/**
 * Local SQLite database viewer using sql.js (in-browser SQLite).
 * Provides the same public API as AdbClient for seamless switching.
 */
import initSqlJs from "sql.js";
import sqlWasm from "sql.js/dist/sql-wasm.wasm?url";

let SQL = null;

async function getSQL() {
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: () => sqlWasm });
  }
  return SQL;
}

export class LocalDb {
  constructor() {
    /** @type {import("sql.js").Database|null} */
    this.db = null;
    this.fileName = "";
  }

  /**
   * Open a SQLite file from an ArrayBuffer.
   */
  async open(arrayBuffer, fileName) {
    const SQLModule = await getSQL();
    if (this.db) this.db.close();
    this.db = new SQLModule.Database(new Uint8Array(arrayBuffer));
    this.fileName = fileName;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.fileName = "";
    }
  }

  isOpen() {
    return !!this.db;
  }

  _ensureOpen() {
    if (!this.db) throw new Error("No local database open.");
  }

  _runQuery(sql) {
    this._ensureOpen();
    const results = this.db.exec(sql);
    if (!results.length) return { columns: [], rows: [] };
    const { columns, values } = results[0];
    const rows = values.map((vals) => {
      const row = {};
      columns.forEach((col, i) => (row[col] = vals[i]));
      return row;
    });
    return { columns, rows };
  }

  async getTables() {
    const { rows } = this._runQuery(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    );
    return rows.map((r) => ({ name: r.name, row_count: 0 }));
  }

  async getTableStructure(tableName) {
    const { rows } = this._runQuery(`PRAGMA table_info(\`${tableName}\`);`);
    return rows;
  }

  async getTableData(tableName, limit = 100, offset = 0) {
    const columns = await this.getTableStructure(tableName);
    if (!columns.length) throw new Error(`Table ${tableName} not found`);

    const { rows } = this._runQuery(
      `SELECT * FROM \`${tableName}\` LIMIT ${limit} OFFSET ${offset};`
    );
    const countResult = this._runQuery(
      `SELECT COUNT(*) as count FROM \`${tableName}\`;`
    );
    const totalCount = countResult.rows.length
      ? Number(countResult.rows[0].count)
      : 0;

    return {
      columns: columns.map((c) => c.name),
      rows,
      row_count: rows.length,
      total_count: totalCount,
      offset,
      limit,
    };
  }

  async executeQuery(sql, limit) {
    this._ensureOpen();
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // Write queries
    if (
      ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "REPLACE"].some(
        (op) => upper.startsWith(op)
      )
    ) {
      this.db.run(trimmed);
      const changes = this.db.getRowsModified();
      return { columns: [], rows: [], row_count: changes };
    }

    // Read queries - append LIMIT if not present
    let finalSql = trimmed;
    if (
      limit &&
      !upper.includes("LIMIT") &&
      upper.startsWith("SELECT")
    ) {
      finalSql = `${trimmed.replace(/;$/, "")} LIMIT ${limit};`;
    }

    const { columns, rows } = this._runQuery(finalSql);
    return { columns, rows, row_count: rows.length };
  }

  async checkDatabaseExists() {
    return this.isOpen();
  }
}
