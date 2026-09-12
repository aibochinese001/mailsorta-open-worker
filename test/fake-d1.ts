/**
 * 轻量内存版 D1：仅为单元/接口测试实现用到的 SQL 子集。
 * 支持：SELECT(cols) FROM t [WHERE a=? AND b=?] [ORDER BY c DESC] [LIMIT ? OFFSET ?]
 *       SELECT COUNT(*) AS n ... / SELECT 1 AS ok ...
 *       INSERT INTO t (cols) VALUES (?,...) / UPDATE t SET c=? WHERE id=? / DELETE FROM t WHERE id=?
 * WHERE 条件支持占位符(?)与字面量(数字/引号字符串)；运算符 = != >= <= LIKE
 */

type Row = Record<string, any>;

interface Cond {
  col: string;
  op: string;
  /** 字面量值；undefined 表示占位符，从 bind 参数中取 */
  lit?: string;
}

export class FakeD1 {
  tables: Record<string, Row[]> = {};
  /** 表级唯一约束（列名数组）：INSERT OR IGNORE 时按此判断冲突 */
  uniques: Record<string, string[]> = {
    emails: ['account_id', 'rule_id', 'message_id'],
  };

  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private stmt: { sql: string; params: unknown[] } = { sql: '', params: [] };
  constructor(
    private db: FakeD1,
    sql: string,
  ) {
    this.stmt.sql = sql;
  }

  bind(...params: unknown[]) {
    this.stmt.params = params;
    return this;
  }

  async all(): Promise<{ results: Row[]; success: boolean }> {
    const { results } = this._select();
    return { results, success: true };
  }

  async first(): Promise<Row | null> {
    const { results } = this._select();
    return results[0] ?? null;
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const sql = this.stmt.sql.trim();
    const params = this.stmt.params;

    if (/^INSERT/i.test(sql)) {
      const ignore = /^INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
      const m = sql.match(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (!m) throw new Error(`FakeD1 不支持的 INSERT: ${sql}`);
      const table = m[1].toLowerCase();
      const cols = m[2].split(',').map((c) => c.trim());
      const row: Row = {};
      cols.forEach((c, i) => {
        row[c] = params[i];
      });
      this.db.tables[table] ??= [];
      if (/ON CONFLICT/i.test(sql)) {
        // upsert：按第一列（主键）替换已有行
        const pk = cols[0];
        const idx = this.db.tables[table].findIndex((r) => r[pk] === row[pk]);
        if (idx >= 0) this.db.tables[table][idx] = row;
        else this.db.tables[table].push(row);
        return { success: true, meta: { changes: 1 } };
      }
      if (ignore) {
        // INSERT OR IGNORE：唯一约束冲突时静默忽略，返回 changes=0（对应真实 SQLite 语义）
        const uniq = this.db.uniques[table];
        const dup = !!uniq && this.db.tables[table].some((r) => uniq.every((c) => String(r[c]) === String(row[c])));
        if (dup) return { success: true, meta: { changes: 0 } };
        this.db.tables[table].push(row);
        return { success: true, meta: { changes: 1 } };
      }
      this.db.tables[table].push(row);
      return { success: true, meta: { changes: 1 } };
    }

    if (/^UPDATE/i.test(sql)) {
      const m = sql.match(/UPDATE (\w+)\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i);
      if (!m) throw new Error(`FakeD1 不支持的 UPDATE: ${sql}`);
      const table = m[1].toLowerCase();
      const sets = m[2].split(',').map((s) => s.trim());
      const values = sets.map((s) => {
        const mm = s.match(/^(\w+)\s*=\s*\?$/i);
        if (!mm) throw new Error(`FakeD1 不支持的 SET: ${s}`);
        return mm[1];
      });
      const conds = this._parseConds(m[3]);
      const rows = this.db.tables[table] ?? [];
      for (const row of rows) {
        if (this._match(row, conds, params, values.length)) {
          values.forEach((col, i) => {
            row[col] = params[i];
          });
        }
      }
      return { success: true, meta: {} };
    }

    if (/^DELETE/i.test(sql)) {
      const m = sql.match(/DELETE FROM (\w+)(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (!m) throw new Error(`FakeD1 不支持的 DELETE: ${sql}`);
      const table = m[1].toLowerCase();
      const rows = this.db.tables[table] ?? [];
      if (!m[2]) {
        this.db.tables[table] = [];
        return { success: true, meta: {} };
      }
      const conds = this._parseConds(m[2]);
      this.db.tables[table] = rows.filter((r) => !this._match(r, conds, params, 0));
      return { success: true, meta: {} };
    }

    throw new Error(`FakeD1 不支持的语句: ${sql}`);
  }

  private _select(): { results: Row[] } {
    const sql = this.stmt.sql.trim();
    const m = sql.match(
      /^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER BY\s+([\s\S]+?))?(?:\s+LIMIT\s+\?)?(?:\s+OFFSET\s+\?)?$/i,
    );
    if (!m) throw new Error(`FakeD1 不支持的 SELECT: ${sql}`);
    const cols = m[1];
    const table = m[2].toLowerCase();
    const where = m[3];
    const orderBy = m[4];

    let rows = [...(this.db.tables[table] ?? [])];
    const params = [...this.stmt.params];
    let used = 0;
    if (where) {
      const conds = this._parseConds(where);
      used = conds.reduce((s, g) => s + g.filter((c) => c.lit === undefined).length, 0);
      rows = rows.filter((r) => this._match(r, conds, params, 0));
    }

    if (/COUNT\(\*\)/i.test(cols)) {
      const alias = /COUNT\(\*\)\s+AS\s+(\w+)/i.exec(cols)?.[1] ?? 'n';
      return { results: [{ [alias]: rows.length }] };
    }
    if (/^1\s+AS/i.test(cols)) {
      return { results: rows.length ? [{ ok: 1 }] : [] };
    }
    if (orderBy) {
      // 支持多列：ORDER BY sort ASC, price_usd ASC
      const keys = orderBy.split(',').map((k) => {
        const km = k.trim().match(/^(\w+)(?:\s+(ASC|DESC))?$/i);
        if (!km) throw new Error(`FakeD1 不支持的 ORDER BY: ${k}`);
        return { col: km[1], dir: (km[2] ?? 'ASC').toUpperCase() as 'ASC' | 'DESC' };
      });
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of keys) {
          const av = a[col];
          const bv = b[col];
          if (av == null && bv == null) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          let cmp: number;
          if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
          else cmp = String(av).localeCompare(String(bv));
          if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp;
        }
        return 0;
      });
    }

    // 剩余参数按 SQL 顺序：...whereParams, LIMIT, OFFSET
    const remaining = params.slice(used);
    if (remaining.length === 1) {
      rows = rows.slice(0, Number(remaining[0]));
    } else if (remaining.length >= 2) {
      const limit = Number(remaining[remaining.length - 2]);
      const offset = Number(remaining[remaining.length - 1]);
      rows = rows.slice(offset, offset + limit);
    }
    return { results: rows };
  }

  private _parseConds(where: string): Cond[][] {
    // 兼容字面量 LIMIT 1 / OFFSET n（非占位符）
    where = where.replace(/\s+LIMIT\s+\d+$/i, '').replace(/\s+OFFSET\s+\d+$/i, '');
    // OR 分组（countPaidUsers 等）：任一 OR 组全部条件满足即命中
    const orGroups = where.split(/\s+OR\s+/i).map((g) => g.replace(/^\(|\)$/g, '').trim());
    return orGroups.map((group) =>
      group.split(/\s+AND\s+/i).map((p) => {
        const mm = p.match(/^(\w+)\s*(=|!=|>=|<=|LIKE)\s*(\?|'[^']*'|\d+(?:\.\d+)?)$/i);
        if (!mm) throw new Error(`FakeD1 不支持的 WHERE: ${p}`);
        return { col: mm[1], op: mm[2].toUpperCase(), lit: mm[3] === '?' ? undefined : mm[3].replace(/^'|'$/g, '') };
      }),
    );
  }

  /** groups: OR 组；每个组内的条件按顺序消耗 params */
  private _match(row: Row, groups: Cond[][], params: unknown[], start: number): boolean {
    let cursor = start;
    for (const conds of groups) {
      let groupOk = true;
      for (let i = 0; i < conds.length; i++) {
        const c = conds[i];
        const v = c.lit !== undefined ? c.lit : params[cursor + i];
        const rv = row[c.col];
        switch (c.op) {
          case '=':
            if (String(rv) !== String(v)) groupOk = false;
            break;
          case '!=':
            if (String(rv) === String(v)) groupOk = false;
            break;
          case '>=':
            if (!(Number(rv) >= Number(v))) groupOk = false;
            break;
          case '<=':
            if (!(Number(rv) <= Number(v))) groupOk = false;
            break;
          case 'LIKE':
            if (!String(rv ?? '').includes(String(v).replace(/%/g, ''))) groupOk = false;
            break;
        }
        if (!groupOk) break;
      }
      if (groupOk) return true;
      cursor += conds.filter((c) => c.lit === undefined).length;
    }
    return false;
  }
}

export class FakeKV {
  store = new Map<string, { value: string; ttl?: number }>();

  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    if (!v) return null;
    if (v.ttl && Date.now() > v.ttl) {
      this.store.delete(key);
      return null;
    }
    return v.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix?: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const names = [...this.store.keys()].filter((k) => (prefix?.prefix ? k.startsWith(prefix.prefix) : true));
    return { keys: names.map((name) => ({ name })) };
  }
}

export class FakeR2 {
  store = new Map<string, ArrayBuffer>();

  async put(key: string, value: ArrayBuffer | string): Promise<unknown> {
    this.store.set(
      key,
      typeof value === 'string' ? (new TextEncoder().encode(value).buffer as ArrayBuffer) : value,
    );
    return {};
  }

  async get(key: string): Promise<{ body: ReadableStream; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const v = this.store.get(key);
    if (!v) return null;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(v));
          controller.close();
        },
      }),
      arrayBuffer: async () => v,
    };
  }
}
