'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      storage_name  TEXT    NOT NULL,
      original_name TEXT    NOT NULL,
      mime_type     TEXT,
      size_bytes    INTEGER NOT NULL,
      duration_ms   INTEGER NOT NULL CHECK (duration_ms > 0),
      translation_lang TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_ms   INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms     INTEGER NOT NULL CHECK (end_ms > start_ms),
      text       TEXT    NOT NULL DEFAULT '',
      reviewed   INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
      revision   INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      UNIQUE (video_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start_ms);

    CREATE TABLE IF NOT EXISTS publications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id     INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      version      INTEGER NOT NULL,
      snapshot     TEXT    NOT NULL,
      translation_snapshot TEXT,
      translation_lang     TEXT,
      segment_count INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE (video_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_publications_video ON publications(video_id, version);

    -- 译文轨道：每段草稿原文至多一条译文（单语言轨道）；
    -- source_* 记录译文录入/更新时对应的原文内容，用于判定「原文变更 -> 译文失效」；
    -- 片段被删除（含整稿替换、区间恢复）时级联删除译文，新片段不沿用旧译文
    CREATE TABLE IF NOT EXISTS translations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id        INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      segment_id      INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      text            TEXT    NOT NULL DEFAULT '',
      reviewed        INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
      revision        INTEGER NOT NULL DEFAULT 1,
      source_start_ms INTEGER NOT NULL,
      source_end_ms   INTEGER NOT NULL,
      source_text     TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE (video_id, segment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_translations_video ON translations(video_id);
  `);

  // 旧库迁移：为已存在的表补充译文轨道相关列（新库已由上方 CREATE 携带则跳过）
  const videoCols = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
  if (!videoCols.includes('translation_lang')) {
    db.exec('ALTER TABLE videos ADD COLUMN translation_lang TEXT');
  }
  const pubCols = db.prepare('PRAGMA table_info(publications)').all().map((c) => c.name);
  if (!pubCols.includes('translation_snapshot')) {
    db.exec('ALTER TABLE publications ADD COLUMN translation_snapshot TEXT');
  }
  if (!pubCols.includes('translation_lang')) {
    db.exec('ALTER TABLE publications ADD COLUMN translation_lang TEXT');
  }

  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

module.exports = { init, get };
