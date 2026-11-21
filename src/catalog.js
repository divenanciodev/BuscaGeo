const { DatabaseSync } = require('node:sqlite');

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

class Catalog {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA temp_store=MEMORY;
      PRAGMA cache_size=-64000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        root TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        directory TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        scan_token TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_text (
        path TEXT PRIMARY KEY COLLATE NOCASE,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        content TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS document_text_fts USING fts5(
        path UNINDEXED, content,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS document_text_ai AFTER INSERT ON document_text BEGIN
        INSERT INTO document_text_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS document_text_ad AFTER DELETE ON document_text BEGIN
        DELETE FROM document_text_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS document_text_au AFTER UPDATE OF path, content ON document_text BEGIN
        DELETE FROM document_text_fts WHERE rowid = old.rowid;
        INSERT INTO document_text_fts(rowid, path, content) VALUES (new.rowid, new.path, new.content);
      END;
      CREATE INDEX IF NOT EXISTS files_root_idx ON files(root COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS files_ext_idx ON files(ext);
      CREATE INDEX IF NOT EXISTS files_mtime_idx ON files(mtime DESC);
      CREATE TABLE IF NOT EXISTS catalog_roots (
        root TEXT PRIMARY KEY COLLATE NOCASE,
        last_scan TEXT NOT NULL,
        files_seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TEMP TABLE IF NOT EXISTS scan_seen (path TEXT PRIMARY KEY COLLATE NOCASE);
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        name, path, content='files', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
      END;
      CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
        DELETE FROM document_text WHERE path = old.path COLLATE NOCASE;
      END;
      CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF name, path ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
        INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
      END;
    `);
    this.db.exec(`
      DROP TRIGGER IF EXISTS files_ad;
      CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
        DELETE FROM document_text WHERE path = old.path COLLATE NOCASE;
      END;
    `);
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version || 0);
    if (version < 1) {
      this.db.exec("INSERT INTO files_fts(files_fts) VALUES('rebuild'); PRAGMA user_version=1;");
    }
    this.insert = this.db.prepare(`
      INSERT INTO files(path,root,name,ext,directory,size,mtime,scan_token)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET
        root=excluded.root, name=excluded.name, ext=excluded.ext,
        directory=excluded.directory, size=excluded.size, mtime=excluded.mtime
      WHERE files.root != excluded.root COLLATE NOCASE
        OR files.name != excluded.name
        OR files.ext != excluded.ext
        OR files.directory != excluded.directory
        OR files.size != excluded.size
        OR files.mtime != excluded.mtime
    `);
    this.markSeen = this.db.prepare('INSERT OR IGNORE INTO scan_seen(path) VALUES(?)');
    this.refreshStats();
  }

  refreshStats() {
    this._count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM files').get().n);
    this._extensions = this.db
      .prepare("SELECT DISTINCT ext FROM files WHERE ext LIKE '.%' ORDER BY ext COLLATE NOCASE")
      .all()
      .map(row => row.ext);
    this._roots = this.db
      .prepare('SELECT root,last_scan AS lastScan,files_seen AS filesSeen FROM catalog_roots ORDER BY root COLLATE NOCASE')
      .all();
  }

  get count() {
    return this._count;
  }

  get extensions() {
    return this._extensions;
  }

  get roots() {
    return this._roots;
  }

  upsertBatch(rows) {
    if (!rows.length) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        this.insert.run(
          row.path,
          row.root,
          row.name,
          row.ext,
          row.directory,
          row.size,
          row.mtime,
          row.scanToken
        );
        if (this.trackSeen) this.markSeen.run(row.path);
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  beginRootScan(bulk = false, root = null) {
    this.db.exec('DELETE FROM scan_seen');
    this.bulkMode = Boolean(bulk);
    this.trackSeen = false;

    if (root) {
      const base = root.replace(/[\\/]+$/, '');
      const existingFile = this.db.prepare(`
        SELECT 1
        FROM files
        WHERE path = ? COLLATE NOCASE
          OR (
            substr(path, 1, length(?)) = ? COLLATE NOCASE
            AND substr(path, length(?) + 1, 1) IN (char(92), '/')
          )
        LIMIT 1
      `).get(base, base, base, base);
      this.trackSeen = Boolean(existingFile);
    }

    if (this.bulkMode) {
      this.db.exec(
        'DROP TRIGGER IF EXISTS files_ai; DROP TRIGGER IF EXISTS files_ad; DROP TRIGGER IF EXISTS files_au;'
      );
    }
  }

  restoreFtsTriggers() {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
        INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
      END;
      CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
      END;
      CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF name, path ON files BEGIN
        INSERT INTO files_fts(files_fts, rowid, name, path) VALUES ('delete', old.id, old.name, old.path);
        INSERT INTO files_fts(rowid, name, path) VALUES (new.id, new.name, new.path);
      END;
    `);
  }

  abortRootScan() {
    if (!this.bulkMode) return;

    this.db.exec("INSERT INTO files_fts(files_fts) VALUES('rebuild');");
    this.restoreFtsTriggers();
    this.bulkMode = false;
    this.trackSeen = false;
  }

  finishRoot(root, scanToken, filesSeen, complete) {
    this.db.exec('BEGIN IMMEDIATE');

    try {
      if (complete && this.trackSeen) {
        const base = root.replace(/[\\/]+$/, '');
        this.db.prepare(`
          DELETE FROM files
          WHERE (
            path = ? COLLATE NOCASE
            OR (
              substr(path, 1, length(?)) = ? COLLATE NOCASE
              AND substr(path, length(?) + 1, 1) IN (char(92), '/')
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM scan_seen s
            WHERE s.path = files.path COLLATE NOCASE
          )
        `).run(base, base, base, base);
      }

      if (complete) {
        this.db.prepare(`INSERT INTO catalog_roots(root,last_scan,files_seen) VALUES(?,?,?)
          ON CONFLICT(root) DO UPDATE SET
            last_scan=excluded.last_scan,
            files_seen=excluded.files_seen
        `).run(root, new Date().toISOString(), filesSeen);
      }

      if (this.bulkMode) {
        this.db.exec("INSERT INTO files_fts(files_fts) VALUES('rebuild');");
        this.restoreFtsTriggers();
      }

      this.db.exec('COMMIT');
      this.bulkMode = false;
      this.trackSeen = false;
      this.refreshStats();
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertOne(row) {
    const previous = this.db.prepare('SELECT ext FROM files WHERE path = ? COLLATE NOCASE').get(row.path);
    this.insert.run(
      row.path,
      row.root,
      row.name,
      row.ext,
      row.directory,
      row.size,
      row.mtime,
      row.scanToken
    );

    if (!previous) {
      this._count++;
      if (row.ext.startsWith('.') && !this._extensions.includes(row.ext)) {
        this._extensions = [...this._extensions, row.ext].sort();
      }
    }
  }

  hasCurrentDocumentText(filePath, mtime, size) {
    const row = this.db.prepare(`
      SELECT 1
      FROM document_text
      WHERE path = ? COLLATE NOCASE
        AND mtime = ?
        AND size = ?
    `).get(filePath, mtime, size);
    return Boolean(row);
  }

  upsertDocumentText(filePath, mtime, size, content) {
    this.db.prepare(`
      INSERT INTO document_text(path,mtime,size,content) VALUES (?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET
        mtime=excluded.mtime,
        size=excluded.size,
        content=excluded.content
    `).run(filePath, mtime, size, content);
  }

  deleteDocumentText(filePath) {
    this.db.prepare(`
      DELETE FROM document_text
      WHERE path = ? COLLATE NOCASE
    `).run(filePath);
  }

  deleteUnsupportedDocumentText(extensions) {
    if (!extensions.length) return;

    this.db.prepare(`
      DELETE FROM document_text
      WHERE path IN (
        SELECT d.path
        FROM document_text d
        JOIN files f ON f.path = d.path COLLATE NOCASE
        WHERE f.ext NOT IN (${extensions.map(() => '?').join(',')})
      )
    `).run(...extensions);
  }

  searchDocumentText(query, roots, limit = 8) {
    const stopWords = new Set([
      'ao', 'aos', 'ate', 'com', 'como', 'da', 'das', 'de', 'do', 'dos',
      'em', 'entre', 'essa', 'esse', 'isso', 'mais', 'meu', 'minha', 'na',
      'nas', 'no', 'nos', 'onde', 'ou', 'para', 'pela', 'pelo', 'por',
      'qual', 'quais', 'quando', 'que', 'quem', 'se', 'sem', 'ser', 'sua',
      'seu', 'sao', 'sobre', 'tem', 'uma', 'umas', 'uns', 'voce'
    ]);
    const tokens = normalize(query).match(/[\p{L}\p{N}_-]{2,}/gu) || [];
    const terms = [...new Set(tokens.filter(token => !stopWords.has(token)))].slice(0, 8);
    if (!terms.length || !roots.length) return [];

    const ftsQuery = terms.map(token => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
    const rootTerms = [];
    const args = [ftsQuery];

    for (const root of roots) {
      const base = root.replace(/[\\/]+$/, '');
      rootTerms.push(`(
        f.path = ? COLLATE NOCASE
        OR (
          substr(f.path, 1, length(?)) = ? COLLATE NOCASE
          AND substr(f.path, length(?) + 1, 1) IN (char(92), '/')
        )
      )`);
      args.push(base, base, base, base);
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 12));
    const search = searchQuery => {
      return this.db.prepare(`
        SELECT
          f.path,
          f.name,
          f.ext,
          f.directory,
          f.size,
          f.mtime,
          snippet(document_text_fts, 1, '', '', ' … ', 32) AS excerpt
        FROM document_text_fts
        JOIN document_text d ON d.rowid = document_text_fts.rowid
        JOIN files f ON f.path = d.path COLLATE NOCASE
        WHERE document_text_fts MATCH ?
          AND (${rootTerms.join(' OR ')})
        ORDER BY bm25(document_text_fts)
        LIMIT ?
      `).all(searchQuery, ...args.slice(1), safeLimit);
    };

    let rows = search(ftsQuery);
    if (!rows.length && terms.length > 1) {
      rows = search(terms.map(token => `"${token.replace(/"/g, '""')}"*`).join(' OR '));
    }

    return rows.map(row => {
      return {
        path: row.path,
        name: row.name,
        ext: row.ext,
        directory: row.directory,
        size: Number(row.size),
        modified: new Date(Number(row.mtime)).toISOString(),
        excerpt: row.excerpt
      };
    });
  }

  hasDocumentTextInRoots(roots) {
    if (!roots.length) return false;

    const rootTerms = [];
    const args = [];
    for (const root of roots) {
      const base = root.replace(/[\\/]+$/, '');
      rootTerms.push(`(
        f.path = ? COLLATE NOCASE
        OR (
          substr(f.path, 1, length(?)) = ? COLLATE NOCASE
          AND substr(f.path, length(?) + 1, 1) IN (char(92), '/')
        )
      )`);
      args.push(base, base, base, base);
    }

    return Boolean(this.db.prepare(`
      SELECT 1
      FROM document_text d
      JOIN files f ON f.path = d.path COLLATE NOCASE
      WHERE length(d.content) > 0
        AND (${rootTerms.join(' OR ')})
      LIMIT 1
    `).get(...args));
  }

  deletePathTree(target) {
    const base = target.replace(/[\\/]+$/, '');
    const result = this.db.prepare(`
      DELETE FROM files
      WHERE path = ? COLLATE NOCASE
        OR (
          substr(path, 1, length(?)) = ? COLLATE NOCASE
          AND substr(path, length(?) + 1, 1) IN (char(92), '/')
        )
    `).run(base, base, base, base);
    this._count = Math.max(0, this._count - Number(result.changes));
  }

  search(filters, roots, references, kinds) {
    const query = normalize(filters.query).trim();
    const tokens = query.split(/\s+/)
      .filter(Boolean)
      .map(token => token.replace(/[^\p{L}\p{N}_-]/gu, ''))
      .filter(token => token.length > 1);
    const extension = String(filters.extension || '').toLowerCase();
    const kind = filters.kind || 'all';
    const sort = ['name', 'path', 'modified'].includes(filters.sort) ? filters.sort : 'modified';

    const hasTooShortToken = tokens.some(token => token.length < 2);
    if ((hasTooShortToken && !extension && kind === 'all') || (kind === 'car' && !tokens.length)) {
      return { rows: [], total: 0, hasMore: false, needsMoreText: true };
    }
    if (!tokens.length && !extension && kind === 'all') {
      return { rows: [], total: 0, hasMore: false, needsMoreText: false };
    }
    if (!roots.length) {
      return { rows: [], total: 0, hasMore: false, needsMoreText: false };
    }

    const ftsQuery = tokens.map(token => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
    const matchingRefs = references.filter(ref =>
      tokens.length && tokens.every(token =>
        normalize(ref.title + ' ' + (ref.names || []).join(' ') + ' ' + (ref.notes || '')).includes(token)
      )
    );
    const where = [];
    const args = ftsQuery ? [ftsQuery] : [];
    const rootTerms = [];

    for (const root of roots) {
      const base = root.replace(/[\\/]+$/, '');
      rootTerms.push(`(
        f.path = ? COLLATE NOCASE
        OR (
          substr(f.path, 1, length(?)) = ? COLLATE NOCASE
          AND substr(f.path, length(?) + 1, 1) IN (char(92), '/')
        )
      )`);
      args.push(base, base, base, base);
    }
    where.push(`(${rootTerms.join(' OR ')})`);

    const contentTerms = [];
    if (ftsQuery) contentTerms.push('matched.rowid IS NOT NULL');

    for (const ref of matchingRefs) {
      const base = String(ref.path || '').replace(/[\\/]+$/, '');
      if (!base) continue;
      contentTerms.push(`(
        f.path = ? COLLATE NOCASE
        OR (
          substr(f.path, 1, length(?)) = ? COLLATE NOCASE
          AND substr(f.path, length(?) + 1, 1) IN (char(92), '/')
        )
      )`);
      args.push(base, base, base, base);
    }

    if (contentTerms.length) where.push(`(${contentTerms.join(' OR ')})`);
    if (extension) {
      where.push('f.ext = ?');
      args.push(extension);
    }

    if (kind === 'geo' || kind === 'docs' || kind === 'tables') {
      const list = kinds[kind] || [];
      if (!list.length) return { rows: [], total: 0, hasMore: false, needsMoreText: false };
      where.push(`f.ext IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }

    const withClause = ftsQuery
      ? 'WITH matched AS MATERIALIZED (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)'
      : '';
    const joins = ftsQuery ? 'LEFT JOIN matched ON matched.rowid = f.id' : '';
    let order = 'f.mtime DESC';
    if (sort === 'name') order = 'f.name COLLATE NOCASE ASC, f.path COLLATE NOCASE ASC';
    else if (sort === 'path') order = 'f.path COLLATE NOCASE ASC';
    else if (ftsQuery) order = 'CASE WHEN matched.rowid IS NULL THEN 1 ELSE 0 END, f.mtime DESC';
    const sqlOrder = ` ORDER BY ${order}`;
    const sql = `
      ${withClause}
      SELECT f.path, f.name, f.ext, f.directory, f.size, f.mtime
      FROM files f
      ${joins}
      WHERE ${where.join(' AND ')}${sqlOrder}
      LIMIT 251
    `;
    const rows = this.db.prepare(sql).all(...args);
    const hasMore = rows.length > 250;
    const page = rows.slice(0, 250);

    const visible = page.map(row => {
      const filePath = String(row.path).toLowerCase();
      const referenceNames = matchingRefs.filter(ref => {
        const base = String(ref.path || '').replace(/[\\/]+$/, '').toLowerCase();
        return base && (
          filePath === base
          || filePath.startsWith(base + '\\')
          || filePath.startsWith(base + '/')
        );
      }).map(ref => ref.title).slice(0, 5);

      return {
        path: row.path,
        name: row.name,
        ext: row.ext,
        directory: row.directory,
        size: Number(row.size),
        modified: new Date(Number(row.mtime)).toISOString(),
        referenceNames
      };
    });

    return { rows: visible, total: hasMore ? null : visible.length, hasMore, needsMoreText: false };
  }

  close() {
    this.db.close();
  }
}

module.exports = { Catalog };
