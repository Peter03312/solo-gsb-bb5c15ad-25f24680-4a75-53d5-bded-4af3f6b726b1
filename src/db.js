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
      segment_count INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE (video_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_publications_video ON publications(video_id, version);

    -- 译文轨道：每个视频至多一个，绑定一种语言
    CREATE TABLE IF NOT EXISTS translation_tracks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id   INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
      language   TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 译文：逐段关联当前草稿原文片段；source_* 记录录入/更新译文时所见的原文内容，
    -- 用于判定「原文文字或时间改变 -> 译文失效」（仅切换原文审校不影响）
    CREATE TABLE IF NOT EXISTS translations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id        INTEGER NOT NULL REFERENCES translation_tracks(id) ON DELETE CASCADE,
      segment_id      INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      text            TEXT    NOT NULL DEFAULT '',
      reviewed        INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
      revision        INTEGER NOT NULL DEFAULT 1,
      source_text     TEXT    NOT NULL DEFAULT '',
      source_start_ms INTEGER NOT NULL,
      source_end_ms   INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      UNIQUE (track_id, segment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_translations_track ON translations(track_id, segment_id);
  `);

  // 老库迁移：publications 增加译文快照列（旧发布版本该列为 NULL，语义不变）
  const pubCols = db.prepare('PRAGMA table_info(publications)').all().map((c) => c.name);
  if (!pubCols.includes('translation_snapshot')) {
    db.exec('ALTER TABLE publications ADD COLUMN translation_snapshot TEXT');
  }

  return db;
}

function get() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

module.exports = { init, get };
