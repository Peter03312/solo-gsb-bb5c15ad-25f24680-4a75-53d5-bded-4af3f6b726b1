'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { get } = require('./db');
const { ApiError, isInt, validateTimeline } = require('./validation');
const { buildSrt, parseSrt } = require('./srt');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'videos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024 },
});

// SRT 文件较小，仅在内存中解析，不落盘
const MAX_SRT_BYTES = Number(process.env.MAX_SRT_KB || 10240) * 1024;
const srtUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SRT_BYTES },
});

// 预览令牌签名密钥：随进程生成；服务重启后旧预览令牌失效（要求重新预览，符合语义）
const TOKEN_SECRET = crypto.randomBytes(32);

const router = express.Router();

const now = () => Date.now();

function mapSegment(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    text: row.text,
    reviewed: row.reviewed === 1,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

function loadVideo(videoId) {
  const video = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
  return video;
}

function listSegments(videoId) {
  return get()
    .prepare('SELECT * FROM segments WHERE video_id = ? ORDER BY start_ms, id')
    .all(videoId)
    .map(mapSegment);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    throw new ApiError(422, 'invalid_text', '字幕文本必须为字符串');
  }
  if (value.length > 10000) {
    throw new ApiError(422, 'invalid_text', '字幕文本过长（上限 10000 字符）');
  }
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseRevision(body) {
  const rev = Number(body && body.revision);
  if (!Number.isInteger(rev) || rev < 1) {
    throw new ApiError(422, 'missing_revision', '请携带所见修订号 revision（正整数）');
  }
  return rev;
}

function mapPublication(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    version: row.version,
    segment_count: row.segment_count,
    has_translation: row.translation_snapshot != null,
    translation_lang: row.translation_lang != null ? row.translation_lang : null,
    published_at: row.published_at,
  };
}

/* ---------------- 译文轨道 ---------------- */

// 译文是否失效：译文录入/更新时绑定的原文内容（时间与文字）与当前原文不一致即失效；
// 仅切换原文审校状态不影响（不参与比较）
function isTranslationStale(trRow, segRow) {
  return (
    trRow.source_start_ms !== segRow.start_ms ||
    trRow.source_end_ms !== segRow.end_ms ||
    trRow.source_text !== segRow.text
  );
}

function mapTranslationJoined(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    segment_id: row.segment_id,
    text: row.text,
    reviewed: row.reviewed === 1,
    revision: row.revision,
    stale: isTranslationStale(row, { start_ms: row.seg_start, end_ms: row.seg_end, text: row.seg_text }),
    source_start_ms: row.source_start_ms,
    source_end_ms: row.source_end_ms,
    source_text: row.source_text,
    updated_at: row.updated_at,
  };
}

const TRANSLATION_JOIN = `
  SELECT t.*, s.start_ms AS seg_start, s.end_ms AS seg_end, s.text AS seg_text
  FROM translations t
  JOIN segments s ON s.id = t.segment_id AND s.video_id = t.video_id`;

function listTranslations(videoId) {
  return get()
    .prepare(`${TRANSLATION_JOIN} WHERE t.video_id = ? ORDER BY s.start_ms, s.id`)
    .all(videoId)
    .map(mapTranslationJoined);
}

function getTranslationRow(videoId, segmentId) {
  return get()
    .prepare(`${TRANSLATION_JOIN} WHERE t.video_id = ? AND t.segment_id = ?`)
    .get(videoId, segmentId);
}

// 译文写操作（录入/修改/审校）必须携带「所见原文修订号 + 所见译文修订号」；
// 过期一律 409 并返回当前原文与译文状态，绝不覆盖他人修改
function requireTrack(video) {
  if (!video.translation_lang) {
    throw new ApiError(422, 'no_translation_track', `视频 #${video.id} 尚未启用译文轨道，请先启用指定语言的译文轨道`);
  }
}

function parseSegmentRevision(body) {
  const rev = Number(body && body.segment_revision);
  if (!Number.isInteger(rev) || rev < 1) {
    throw new ApiError(422, 'missing_revision', '请携带所见原文修订号 segment_revision（正整数）');
  }
  return rev;
}

function conflictCurrent(videoId, segmentId) {
  const seg = get().prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(segmentId, videoId);
  const tr = getTranslationRow(videoId, segmentId);
  return { segment: seg ? mapSegment(seg) : null, translation: tr ? mapTranslationJoined(tr) : null };
}

// 启用译文轨道（同一视频仅可启用一个指定语言；换语言须先停用）
router.put('/videos/:id(\\d+)/translation/track', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const language = typeof req.body.language === 'string' ? req.body.language.trim() : '';
    if (!language || language.length > 40 || /[\r\n]/.test(language)) {
      throw new ApiError(422, 'invalid_language', '请指定译文语言 language（1–40 个字符、不含换行，如 en / zh-Hans / 日语）');
    }
    if (video.translation_lang === language) {
      res.json({ ok: true, translation_lang: video.translation_lang, already_enabled: true });
      return;
    }
    if (video.translation_lang) {
      throw new ApiError(422, 'track_exists',
        `该视频已启用「${video.translation_lang}」译文轨道；同一视频仅支持一个指定语言，如需更换请先停用当前轨道（将删除全部译文）`);
    }
    get().prepare('UPDATE videos SET translation_lang = ? WHERE id = ?').run(language, video.id);
    res.status(201).json({ ok: true, translation_lang: language, already_enabled: false });
  } catch (err) {
    next(err);
  }
});

// 停用译文轨道：删除该视频全部译文（发布版本快照不受影响）
router.delete('/videos/:id(\\d+)/translation/track', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    if (!video.translation_lang) {
      throw new ApiError(404, 'no_translation_track', `视频 #${video.id} 未启用译文轨道`);
    }
    get().transaction(() => {
      get().prepare('DELETE FROM translations WHERE video_id = ?').run(video.id);
      get().prepare('UPDATE videos SET translation_lang = NULL WHERE id = ?').run(video.id);
    })();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 录入 / 修改译文：{text, segment_revision, revision?（已存在译文时必填）}
// 修改译文（文字变化或原文已变化需重新绑定）会撤销其审校状态
router.put('/videos/:id(\\d+)/segments/:sid(\\d+)/translation', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    requireTrack(video);
    const text = normalizeText(req.body.text != null ? req.body.text : '');
    const segRev = parseSegmentRevision(req.body);
    const segmentId = Number(req.params.sid);

    const result = get().transaction(() => {
      const seg = get().prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(segmentId, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      if (seg.revision !== segRev) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      const existing = getTranslationRow(video.id, segmentId);
      if (existing) {
        const rev = parseRevision(req.body);
        if (existing.revision !== rev) {
          throw new ApiError(409, 'revision_conflict',
            '译文修订号已过期：该译文已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
            { current: conflictCurrent(video.id, segmentId) });
        }
        // 文字被修改，或原文已变化（译文失效）需重新绑定当前原文 -> 撤销译文审校
        const changed = existing.text !== text || isTranslationStale(existing, seg);
        get().prepare(
          `UPDATE translations
           SET text = ?, reviewed = ?, revision = revision + 1,
               source_start_ms = ?, source_end_ms = ?, source_text = ?, updated_at = ?
           WHERE id = ?`
        ).run(text, changed ? 0 : existing.reviewed, seg.start_ms, seg.end_ms, seg.text, now(), existing.id);
        return { created: false, translation: mapTranslationJoined(getTranslationRow(video.id, segmentId)) };
      }
      const ts = now();
      const info = get().prepare(
        `INSERT INTO translations (video_id, segment_id, text, reviewed, revision,
                                   source_start_ms, source_end_ms, source_text, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`
      ).run(video.id, segmentId, text, seg.start_ms, seg.end_ms, seg.text, ts, ts);
      return { created: true, translation: mapTranslationJoined(getTranslationRow(video.id, segmentId)) };
    })();

    res.status(result.created ? 201 : 200).json({
      translation: result.translation,
      translations: listTranslations(video.id),
    });
  } catch (err) {
    next(err);
  }
});

// 审校 / 取消审校译文：{reviewed, segment_revision, revision}
// 已失效译文（原文已变更）不能标记已审，需先按当前原文重新校对译文
router.post('/videos/:id(\\d+)/segments/:sid(\\d+)/translation/review', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    requireTrack(video);
    const segRev = parseSegmentRevision(req.body);
    const rev = parseRevision(req.body);
    const reviewed = req.body.reviewed === true || req.body.reviewed === false ? req.body.reviewed : null;
    if (reviewed == null) throw new ApiError(422, 'invalid_reviewed', '请提交 reviewed: true/false');
    const segmentId = Number(req.params.sid);

    const translation = get().transaction(() => {
      const seg = get().prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(segmentId, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${segmentId} 不存在`);
      if (seg.revision !== segRev) {
        throw new ApiError(409, 'revision_conflict',
          '原文修订号已过期：该片段已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      const tr = getTranslationRow(video.id, segmentId);
      if (!tr) throw new ApiError(404, 'translation_not_found', `片段 #${segmentId} 尚无译文，请先录入译文`);
      if (tr.revision !== rev) {
        throw new ApiError(409, 'revision_conflict',
          '译文修订号已过期：该译文已被他人修改，已为你加载当前原文与译文状态，请基于当前内容重试',
          { current: conflictCurrent(video.id, segmentId) });
      }
      if (reviewed && isTranslationStale(tr, seg)) {
        throw new ApiError(422, 'translation_stale',
          '译文已失效：原文的文字或时间已变化，请先按当前原文重新校对译文，再标记审校',
          { current: conflictCurrent(video.id, segmentId) });
      }
      get().prepare('UPDATE translations SET reviewed = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(reviewed ? 1 : 0, now(), tr.id);
      return mapTranslationJoined(getTranslationRow(video.id, segmentId));
    })();

    res.json({ translation, translations: listTranslations(video.id) });
  } catch (err) {
    next(err);
  }
});


/* ---------------- 视频 ---------------- */

router.get('/videos', (req, res) => {
  const rows = get()
    .prepare(
      `SELECT v.*,
              (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id) AS segment_count,
              (SELECT COUNT(*) FROM segments s WHERE s.video_id = v.id AND s.reviewed = 1) AS reviewed_count,
              (SELECT MAX(p.version) FROM publications p WHERE p.video_id = v.id) AS latest_version
       FROM videos v ORDER BY v.created_at DESC`
    )
    .all();
  res.json({ videos: rows });
});

router.post('/videos', upload.single('video'), (req, res, next) => {
  let savedPath = null;
  try {
    const title = (req.body.title || '').trim();
    const durationMs = Number(req.body.duration_ms);
    if (!title) throw new ApiError(422, 'invalid_title', '请填写视频标题');
    if (!req.file) throw new ApiError(422, 'missing_file', '请上传视频文件（字段名 video）');
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new ApiError(422, 'invalid_duration', '请由浏览器读取并提交正整数形式的视频时长 duration_ms（毫秒）');
    }

    savedPath = req.file.path;
    const info = get()
      .prepare(
        `INSERT INTO videos (title, storage_name, original_name, mime_type, size_bytes, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(title, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, durationMs, now());

    const video = loadVideo(info.lastInsertRowid);
    res.status(201).json({ video, segments: [], publications: [] });
  } catch (err) {
    if (savedPath) fs.promises.unlink(savedPath).catch(() => {});
    next(err);
  }
});

router.get('/videos/:id(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    res.json({
      video,
      segments: listSegments(video.id),
      translation_lang: video.translation_lang != null ? video.translation_lang : null,
      translations: video.translation_lang ? listTranslations(video.id) : [],
      publications: get()
        .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC')
        .all(video.id)
        .map(mapPublication),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/videos/:id(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const tx = get().transaction(() => {
      get().prepare('DELETE FROM segments WHERE video_id = ?').run(video.id);
      get().prepare('DELETE FROM publications WHERE video_id = ?').run(video.id);
      get().prepare('DELETE FROM videos WHERE id = ?').run(video.id);
    });
    tx();
    fs.promises.unlink(path.join(UPLOAD_DIR, video.storage_name)).catch(() => {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// 视频流（支持 Range 拖动播放）
router.get('/videos/:id(\\d+)/media', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const filePath = path.join(UPLOAD_DIR, video.storage_name);
    if (!fs.existsSync(filePath)) throw new ApiError(404, 'file_missing', '视频文件在服务器上缺失');

    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size) {
        res.status(416).set({ 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': video.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.set({
        'Accept-Ranges': 'bytes',
        'Content-Length': stat.size,
        'Content-Type': video.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

/* ---------------- 字幕片段 ---------------- */

// 事务内基于库内最新全量片段做校验；冲突/非法均不改动任何数据
function mutateSegment(videoId, existingId, candidate, expectedRevision) {
  const dbx = get();
  return dbx.transaction(() => {
    const video = dbx.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);

    let existing = null;
    if (existingId != null) {
      existing = dbx.prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?').get(existingId, videoId);
      if (!existing) throw new ApiError(404, 'segment_not_found', `片段 #${existingId} 不存在`);
      if (existing.revision !== expectedRevision) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，已为你加载最新内容，请基于当前内容重试', {
          current: mapSegment(existing),
        });
      }
    }

    const all = dbx.prepare('SELECT * FROM segments WHERE video_id = ?').all(videoId);
    const timeline = all.map((row) =>
      row.id === existingId ? { id: row.id, start_ms: candidate.start_ms, end_ms: candidate.end_ms } : row
    );
    if (existingId == null) {
      timeline.push({ id: '(new)', start_ms: candidate.start_ms, end_ms: candidate.end_ms });
    }

    const check = validateTimeline(timeline, video.duration_ms);
    if (!check.ok) {
      throw new ApiError(422, 'invalid_timeline', check.reason, existing ? { current: mapSegment(existing) } : {});
    }

    if (existingId == null) {
      const info = dbx
        .prepare(
          `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, ?)`
        )
        .run(videoId, candidate.start_ms, candidate.end_ms, candidate.text, now());
      return mapSegment(dbx.prepare('SELECT * FROM segments WHERE id = ?').get(info.lastInsertRowid));
    }

    // 内容（时间或文本）被修改 -> 撤销审校状态；仅切换审校不走此接口
    const contentChanged =
      existing.start_ms !== candidate.start_ms ||
      existing.end_ms !== candidate.end_ms ||
      existing.text !== candidate.text;

    const nextReviewed = contentChanged ? 0 : existing.reviewed;
    dbx
      .prepare(
        `UPDATE segments SET start_ms = ?, end_ms = ?, text = ?, reviewed = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`
      )
      .run(candidate.start_ms, candidate.end_ms, candidate.text, nextReviewed, now(), existingId);

    return mapSegment(dbx.prepare('SELECT * FROM segments WHERE id = ?').get(existingId));
  })();
}

function readCandidate(body, fallback) {
  if (body.start_ms == null || body.end_ms == null) {
    throw new ApiError(422, 'missing_fields', '请同时提供 start_ms 与 end_ms（毫秒）');
  }
  const startMs = Number(body.start_ms);
  const endMs = Number(body.end_ms);
  if (!isInt(startMs) || !isInt(endMs)) {
    throw new ApiError(422, 'invalid_time', '起止时间必须为整数毫秒');
  }
  const text = normalizeText(body.text != null ? body.text : fallback != null ? fallback.text : '');
  return { start_ms: startMs, end_ms: endMs, text };
}

router.post('/videos/:id(\\d+)/segments', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const candidate = readCandidate(req.body, null);
    const created = mutateSegment(video.id, null, candidate, null);
    res.status(201).json({ segment: created, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

router.put('/videos/:id(\\d+)/segments/:sid(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    const existing = get()
      .prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?')
      .get(req.params.sid, video.id);
    if (!existing) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
    const merged = {
      start_ms: req.body.start_ms != null ? Number(req.body.start_ms) : existing.start_ms,
      end_ms: req.body.end_ms != null ? Number(req.body.end_ms) : existing.end_ms,
      text: req.body.text != null ? normalizeText(req.body.text) : existing.text,
    };
    if (!isInt(merged.start_ms) || !isInt(merged.end_ms)) {
      throw new ApiError(422, 'invalid_time', '起止时间必须为整数毫秒', { current: mapSegment(existing) });
    }
    const updated = mutateSegment(video.id, existing.id, merged, expected);
    res.json({ segment: updated, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

// 审校 / 取消审校；修改已审片段的内容会由 PUT 自动撤销审校
router.post('/videos/:id(\\d+)/segments/:sid(\\d+)/review', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    const reviewed = req.body.reviewed === true || req.body.reviewed === false ? req.body.reviewed : null;
    if (reviewed == null) throw new ApiError(422, 'invalid_reviewed', '请提交 reviewed: true/false');

    const result = get().transaction(() => {
      const seg = get()
        .prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?')
        .get(req.params.sid, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，已为你加载最新内容，请基于当前内容重试', {
          current: mapSegment(seg),
        });
      }
      // 审校前再次确认时间合法，避免对非法草稿盖章
      const timeline = get()
        .prepare('SELECT id, start_ms, end_ms FROM segments WHERE video_id = ?')
        .all(video.id);
      const check = validateTimeline(timeline, video.duration_ms);
      if (!check.ok) throw new ApiError(422, 'invalid_timeline', `无法标记审校：${check.reason}`, { current: mapSegment(seg) });

      get()
        .prepare('UPDATE segments SET reviewed = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(reviewed ? 1 : 0, now(), seg.id);
      return mapSegment(get().prepare('SELECT * FROM segments WHERE id = ?').get(seg.id));
    })();

    res.json({ segment: result, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/videos/:id(\\d+)/segments/:sid(\\d+)', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const expected = parseRevision(req.body);
    get().transaction(() => {
      const seg = get()
        .prepare('SELECT * FROM segments WHERE id = ? AND video_id = ?')
        .get(req.params.sid, video.id);
      if (!seg) throw new ApiError(404, 'segment_not_found', `片段 #${req.params.sid} 不存在`);
      if (seg.revision !== expected) {
        throw new ApiError(409, 'revision_conflict', '修订号已过期：该片段已被他人修改，请刷新后再删除', {
          current: mapSegment(seg),
        });
      }
      get().prepare('DELETE FROM segments WHERE id = ?').run(seg.id);
    })();
    res.json({ ok: true, segments: listSegments(video.id) });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 发布与导出 ---------------- */

// 发布门禁：原文全部已审且时间合法；启用译文轨道时还要求每段译文齐备、
// 已审且对应当前原文内容（未失效）。pending 逐段列出待处理问题，供工作台定位。
function publicationStatus(video, segments, translations) {
  const problems = [];
  const pending = [];
  if (segments.length === 0) problems.push('至少需要一个字幕片段才能发布');
  if (segments.some((s) => !s.reviewed)) problems.push('仍有片段未通过审校');
  const check = validateTimeline(segments, video.duration_ms);
  if (!check.ok) problems.push(check.reason);

  for (const s of segments) {
    const reasons = [];
    if (!s.reviewed) reasons.push('segment_unreviewed');
    if (video.translation_lang) {
      const tr = translations.find((t) => t.segment_id === s.id);
      if (!tr) reasons.push('translation_missing');
      else {
        if (tr.stale) reasons.push('translation_stale');
        if (!tr.reviewed) reasons.push('translation_unreviewed');
      }
    }
    if (reasons.length) {
      pending.push({ segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, reasons });
    }
  }

  let translation = null;
  if (video.translation_lang) {
    const missing = pending.filter((p) => p.reasons.includes('translation_missing')).length;
    const stale = pending.filter((p) => p.reasons.includes('translation_stale')).length;
    const unreviewed = pending.filter((p) => p.reasons.includes('translation_unreviewed')).length;
    translation = {
      language: video.translation_lang,
      total: segments.length,
      translated: translations.length,
      reviewed: translations.filter((t) => t.reviewed && !t.stale).length,
      missing,
      stale,
      unreviewed,
    };
    const parts = [];
    if (missing) parts.push(`${missing} 段缺少译文`);
    if (stale) parts.push(`${stale} 段译文已失效（原文已变更，需重新校对）`);
    if (unreviewed) parts.push(`${unreviewed} 段译文待审校`);
    if (parts.length) problems.push(`译文轨道（${video.translation_lang}）：${parts.join('、')}`);
  }

  return { canPublish: problems.length === 0, problems, pending, translation };
}

router.get('/videos/:id(\\d+)/status', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const segments = listSegments(video.id);
    const translations = video.translation_lang ? listTranslations(video.id) : [];
    const status = publicationStatus(video, segments, translations);
    res.json({ ...status, duration_ms: video.duration_ms });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/publish', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const pub = get().transaction(() => {
      const locked = get().prepare('SELECT * FROM videos WHERE id = ?').get(video.id);
      if (!locked) throw new ApiError(404, 'not_found', `视频 #${video.id} 不存在`);
      const segments = listSegments(video.id);
      const translations = locked.translation_lang ? listTranslations(video.id) : [];
      const status = publicationStatus(locked, segments, translations);
      if (!status.canPublish) {
        // 不生成部分版本：事务在此抛出，无任何写入
        throw new ApiError(422, 'not_publishable', `当前草稿不能发布：${status.problems.join('；')}`,
          { pending: status.pending, translation: status.translation });
      }
      const maxRow = get()
        .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM publications WHERE video_id = ?')
        .get(video.id);
      const version = maxRow.v + 1;
      // 发布快照固定两轨内容：原文快照结构不变；启用译文轨道时另存译文快照
      const snapshot = JSON.stringify(
        segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }))
      );
      let translationSnapshot = null;
      if (locked.translation_lang) {
        const bySeg = new Map(translations.map((t) => [t.segment_id, t]));
        translationSnapshot = JSON.stringify(
          segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: bySeg.get(s.id).text }))
        );
      }
      const info = get()
        .prepare(
          `INSERT INTO publications (video_id, version, snapshot, translation_snapshot, translation_lang, segment_count, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(video.id, version, snapshot, translationSnapshot, locked.translation_lang, segments.length, now());
      return get().prepare('SELECT * FROM publications WHERE id = ?').get(info.lastInsertRowid);
    })();
    res.status(201).json({ publication: mapPublication(pub) });
  } catch (err) {
    next(err);
  }
});

router.get('/videos/:id(\\d+)/publications', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const pubs = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC')
      .all(video.id)
      .map(mapPublication);
    res.json({ publications: pubs });
  } catch (err) {
    next(err);
  }
});

function resolveSnapshot(video, versionParam) {
  if (!versionParam || versionParam === 'draft') {
    return { segments: listSegments(video.id), label: 'draft', displayName: '草稿' };
  }
  if (versionParam === 'published') {
    const row = get()
      .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC LIMIT 1')
      .get(video.id);
    if (!row) throw new ApiError(404, 'no_publication', '该视频尚无已发布版本');
    return { segments: JSON.parse(row.snapshot), label: `v${row.version}`, displayName: `已发布 v${row.version}`, version: row.version };
  }
  const version = Number(versionParam);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(422, 'invalid_version', 'version 取值：draft、published 或正整数版本号');
  }
  const row = get()
    .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
    .get(video.id, version);
  if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
  return { segments: JSON.parse(row.snapshot), label: `v${row.version}`, displayName: `已发布 v${row.version}`, version: row.version };
}

router.get('/videos/:id(\\d+)/srt', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { segments, displayName, label } = resolveSnapshot(video, req.query.version);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(video.title)}-${label}.srt`);
    res.setHeader('X-Subtitle-Desc', encodeURIComponent(displayName));
    res.send(buildSrt(segments));
  } catch (err) {
    next(err);
  }
});

// 译文 SRT 导出：草稿（?version=draft，默认）或含译文的发布版本（published / 版本号）。
// 草稿在译文缺失或失效时拒绝并逐段指出；旧发布版本（无译文快照）拒绝。
router.get('/videos/:id(\\d+)/srt/translation', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const versionParam = req.query.version;

    if (!versionParam || versionParam === 'draft') {
      requireTrack(video);
      const segments = listSegments(video.id);
      const translations = listTranslations(video.id);
      const bySeg = new Map(translations.map((t) => [t.segment_id, t]));
      const pending = [];
      for (const s of segments) {
        const tr = bySeg.get(s.id);
        if (!tr) {
          pending.push({ segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, reason: 'translation_missing',
            message: `片段 #${s.id}（${s.start_ms}–${s.end_ms}ms）缺少译文` });
        } else if (tr.stale) {
          pending.push({ segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, reason: 'translation_stale',
            message: `片段 #${s.id}（${s.start_ms}–${s.end_ms}ms）的译文已失效：原文已变更，需重新校对` });
        }
      }
      if (pending.length) {
        throw new ApiError(422, 'translation_incomplete',
          `草稿译文不完整，无法导出译文 SRT（${pending.length} 段待处理）：\n${pending[0].message}`,
          { pending, translation_lang: video.translation_lang });
      }
      const entries = segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: bySeg.get(s.id).text }));
      sendTranslationSrt(res, video, entries, 'draft', video.translation_lang, '译文草稿');
      return;
    }

    let row;
    let label;
    if (versionParam === 'published') {
      row = get()
        .prepare('SELECT * FROM publications WHERE video_id = ? ORDER BY version DESC LIMIT 1')
        .get(video.id);
      if (!row) throw new ApiError(404, 'no_publication', '该视频尚无已发布版本');
      label = `v${row.version}`;
    } else {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 1) {
        throw new ApiError(422, 'invalid_version', 'version 取值：draft、published 或正整数版本号');
      }
      row = get()
        .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
        .get(video.id, version);
      if (!row) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
      label = `v${version}`;
    }
    if (row.translation_snapshot == null) {
      throw new ApiError(422, 'translation_unavailable',
        `发布版本 ${label} 不含译文轨道（发布时未启用译文轨道），无法导出译文 SRT`);
    }
    sendTranslationSrt(res, video, JSON.parse(row.translation_snapshot), label,
      row.translation_lang, `译文 · 已发布 ${label}`);
  } catch (err) {
    next(err);
  }
});

function sendTranslationSrt(res, video, entries, label, lang, displayName) {
  const suffix = lang ? `.${lang}` : '';
  res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(video.title)}-${label}${encodeURIComponent(suffix)}.srt`);
  res.setHeader('X-Subtitle-Desc', encodeURIComponent(displayName));
  res.send(buildSrt(entries));
}

/* ---------------- SRT 导入（预览 -> 确认追加/替换草稿） ---------------- */

function entryLabel(e) {
  return `导入条目「序号 ${e.seq == null ? '(缺)' : e.seq}」（原文件第 ${e.line} 行）`;
}
function existingLabel(s) {
  return `现有草稿片段 #${s.id}`;
}

// 语义校验：负时间 / 起止倒置 / 越过视频时长 / 导入条目之间重叠；文本过长
// 返回 { errors, validEntries }，其中重叠只在各项基础时间合法时检查
function evaluateImportedEntries(entries, durationMs) {
  const errors = [];
  const valid = [];
  entries.forEach((e) => {
    let selfOk = true;
    if (e.start_ms < 0 || e.end_ms < 0) {
      errors.push({ code: 'negative_time', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：时间不能为负数（起点 ${e.start_ms}ms / 终点 ${e.end_ms}ms）` });
      selfOk = false;
    }
    if (e.start_ms >= 0 && e.end_ms >= 0 && e.start_ms >= e.end_ms) {
      errors.push({ code: 'reversed_time', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：起点（${e.start_ms}ms）必须早于终点（${e.end_ms}ms）` });
      selfOk = false;
    }
    if (e.end_ms > durationMs) {
      errors.push({ code: 'beyond_duration', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：终点 ${e.end_ms}ms 越过视频时长 ${durationMs}ms` });
      selfOk = false;
    }
    if (e.text.length > 10000) {
      errors.push({ code: 'text_too_long', entry: e.entry, seq: e.seq, line: e.line,
        message: `${entryLabel(e)}：字幕文本 ${e.text.length} 字符，超过单条 10000 字符上限` });
      selfOk = false;
    }
    if (selfOk) valid.push(e);
  });

  const ordered = [...valid].sort((a, b) => a.start_ms - b.start_ms || a.entry - b.entry);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.start_ms < prev.end_ms) {
      errors.push({ code: 'imported_overlap', entry: cur.entry, seq: cur.seq, line: cur.line,
        message: `${entryLabel(prev)} 与 ${entryLabel(cur)} 时间重叠（${cur.start_ms}ms 早于 ${prev.end_ms}ms，端点相接允许）` });
    }
  }
  return { errors, validEntries: errors.length ? [] : valid };
}

// 追加模式：逐条给出与现有草稿的冲突（仅信息性；存在冲突时禁止确认追加）
function draftConflicts(existing, entries) {
  const conflicts = [];
  entries.forEach((e) => {
    for (const s of existing) {
      if (e.start_ms < s.end_ms && s.start_ms < e.end_ms) {
        conflicts.push({
          entry: e.entry,
          seq: e.seq,
          line: e.line,
          segment_id: s.id,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          message: `${entryLabel(e)}（${e.start_ms}–${e.end_ms}ms）与${existingLabel(s)}（${s.start_ms}–${s.end_ms}ms）时间冲突`,
        });
      }
    }
  });
  return conflicts;
}

// 草稿快照指纹：任何修改（增删改、审校）都会改变结果
function draftFingerprint(segments) {
  const payload = segments
    .map((s) => [s.id, s.start_ms, s.end_ms, s.text, s.reviewed, s.revision].join('|'))
    .join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
function srtHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
function makePreviewToken({ videoId, mode, draftHash, contentHash, extra }) {
  const payload = JSON.stringify({ v: videoId, m: mode, d: draftHash, c: contentHash, ...(extra || {}) });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}
function readPreviewToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// 从 multipart（字段 srt）或 JSON（字段 content，UTF-8 字符串）读取待导入文本
function readSrtInput(req) {
  if (req.file) {
    return { content: req.file.buffer.toString('utf8'), filename: req.file.originalname || 'import.srt' };
  }
  if (req.body && typeof req.body.content === 'string') {
    return { content: req.body.content, filename: req.body.filename || 'inline.srt' };
  }
  throw new ApiError(422, 'missing_srt', '请上传 SRT 文件（multipart 字段名 srt）或在 JSON 体中提供 content 字段（UTF-8 文本）');
}

function invalidSrtError(message, errors) {
  return new ApiError(422, 'invalid_srt', message, { errors });
}

// 解析 + 语义校验；任何错误都抛 422 invalid_srt，绝不写入
function parseAndEvaluate(content, video) {
  const parsed = parseSrt(content);
  if (!parsed.ok) {
    throw invalidSrtError(`SRT 解析失败，共 ${parsed.errors.length} 处格式问题，未写入任何内容：\n${parsed.errors[0].message}`,
      parsed.errors);
  }
  const { errors, validEntries } = evaluateImportedEntries(parsed.entries, video.duration_ms);
  if (errors.length) {
    throw invalidSrtError(`SRT 时间校验失败，共 ${errors.length} 处问题，未写入任何内容：\n${errors[0].message}`, errors);
  }
  return validEntries;
}

// 仅在 multipart 请求时解析 SRT 上传；JSON（content 字段）请求直接放行
function srtUploadOptional(req, res, next) {
  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
  srtUpload.single('srt')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      next(new ApiError(422, 'srt_too_large', `SRT 文件超过大小上限（MAX_SRT_KB，当前上限 ${Math.round(MAX_SRT_BYTES / 1024)} KB）`));
      return;
    }
    next(err);
  });
}

router.post('/videos/:id(\\d+)/srt/preview', srtUploadOptional, (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { content, filename } = readSrtInput(req);
    const entries = parseAndEvaluate(content, video);
    const existing = listSegments(video.id);
    const conflicts = draftConflicts(existing, entries);

    const draftHash = draftFingerprint(existing);
    const contentHash = srtHash(content);
    const token = makePreviewToken({
      videoId: video.id, mode: 'preview', draftHash, contentHash,
    });

    res.json({
      filename,
      duration_ms: video.duration_ms,
      draft_count: existing.length,
      imported_count: entries.length,
      entries: entries.map((e) => ({
        entry: e.entry,
        seq: e.seq,
        line: e.line,
        time_line: e.time_line,
        start_ms: e.start_ms,
        end_ms: e.end_ms,
        text: e.text,
      })),
      conflicts,
      append_blocked: conflicts.length > 0,
      token,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/srt/import', srtUploadOptional, (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const video = loadVideo(videoId);
    const mode = req.body && req.body.mode === 'replace' ? 'replace' : req.body && req.body.mode === 'append' ? 'append' : null;
    if (!mode) throw new ApiError(422, 'invalid_mode', '请指定写入方式 mode：append（追加到草稿）或 replace（替换整个草稿）');
    const token = readPreviewToken(req.body && req.body.token);
    if (!token) {
      throw new ApiError(409, 'preview_required', '缺少有效的预览令牌：请先调用预览接口，再以预览返回的 token 确认');
    }

    const { content } = readSrtInput(req);
    const currentSegments = listSegments(video.id);
    const currentDraftHash = draftFingerprint(currentSegments);
    if (token.v !== video.id || token.m !== 'preview' || token.d !== currentDraftHash) {
      throw new ApiError(409, 'draft_changed',
        '预览之后草稿已被修改（可能是他人操作）。为避免覆盖更改，请重新预览后再确认；本次未写入任何内容',
        { current_segments: currentSegments });
    }
    if (token.c !== srtHash(content)) {
      throw new ApiError(422, 'srt_changed', '确认时提交的 SRT 内容与预览时不一致，请重新预览后再确认；本次未写入任何内容');
    }

    // 重新解析与全量校验（不信任预览结果），并在同一事务内整批写入
    const result = get().transaction(() => {
      const lockedVideo = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!lockedVideo) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);

      const entries = parseAndEvaluate(content, lockedVideo);

      if (mode === 'append') {
        const existingRows = get().prepare('SELECT * FROM segments WHERE video_id = ?').all(videoId);
        const conflicts = draftConflicts(existingRows, entries);
        if (conflicts.length) {
          throw invalidSrtError(
            `追加被阻止：导入条目与当前草稿存在 ${conflicts.length} 处时间冲突，请先调整草稿或改用替换；本次未写入任何内容：\n${conflicts[0].message}`,
            conflicts.map((c) => ({ code: 'draft_conflict', ...c })));
        }
      }

      const ts = now();
      const insert = get().prepare(
        `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      );
      if (mode === 'replace') {
        get().prepare('DELETE FROM segments WHERE video_id = ?').run(videoId);
      }
      for (const e of entries) {
        insert.run(videoId, e.start_ms, e.end_ms, e.text, ts);
      }
      return { mode, imported_count: entries.length };
    })();

    res.status(201).json({
      ok: true,
      mode: result.mode,
      imported_count: result.imported_count,
      segments: listSegments(video.id),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------- 历史版本区间恢复（预览 -> 确认整体替换） ---------------- */

// 解析并校验恢复请求：版本号为正整数；区间为整数毫秒、起点早于终点、均在视频时长内
function readRestoreRange(body, video) {
  const version = Number(body && body.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new ApiError(422, 'invalid_version', '请指定要恢复的历史发布版本号 version（正整数）');
  }
  if (!body || body.start_ms == null || body.end_ms == null) {
    throw new ApiError(422, 'invalid_range', '请同时提供区间起点 start_ms 与终点 end_ms（整数毫秒）');
  }
  const startMs = Number(body.start_ms);
  const endMs = Number(body.end_ms);
  if (!isInt(startMs) || !isInt(endMs)) {
    throw new ApiError(422, 'invalid_range', '区间起点 start_ms 与终点 end_ms 必须为整数毫秒');
  }
  if (startMs < 0) {
    throw new ApiError(422, 'invalid_range', `区间起点不能为负数（收到 ${startMs}ms）`);
  }
  if (startMs >= endMs) {
    throw new ApiError(422, 'invalid_range', `区间起点（${startMs}ms）必须早于终点（${endMs}ms）`);
  }
  if (endMs > video.duration_ms) {
    throw new ApiError(422, 'invalid_range', `区间终点 ${endMs}ms 越过视频时长 ${video.duration_ms}ms`);
  }
  return { version, startMs, endMs };
}

function loadPublication(videoId, version) {
  const pub = get()
    .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
    .get(videoId, version);
  if (!pub) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
  return pub;
}

// 计算恢复计划：边界不得穿过任一侧片段；区间内以历史片段整体替换；替换后时间线必须合法。
// 任何不合法都抛错，调用方保证不写入。
function planRestore(video, snapshotEntries, draftSegments, startMs, endMs) {
  const crossings = [];
  const collectCrossings = (side, seg, label, extra) => {
    for (const [boundary, at] of [['start', startMs], ['end', endMs]]) {
      if (seg.start_ms < at && at < seg.end_ms) {
        const sideName = side === 'draft' ? '当前草稿片段' : '发布快照';
        const boundaryName = boundary === 'start' ? '起点' : '终点';
        crossings.push({
          side,
          boundary,
          at,
          ...extra,
          start_ms: seg.start_ms,
          end_ms: seg.end_ms,
          message: `区间${boundaryName} ${at}ms 穿过${sideName}${label}（${seg.start_ms}–${seg.end_ms}ms）`,
        });
      }
    }
  };
  draftSegments.forEach((s) => collectCrossings('draft', s, ` #${s.id}`, { segment_id: s.id }));
  snapshotEntries.forEach((e, i) => collectCrossings('published', e, `第 ${i + 1} 条`, { snapshot_index: i + 1 }));
  if (crossings.length) {
    throw new ApiError(422, 'range_crosses_segment',
      `区间边界穿过 ${crossings.length} 个片段，请把起点/终点调整到片段间隙（端点相接允许）：\n${crossings[0].message}`,
      { crossings });
  }

  // 边界不穿过后，与区间相交的片段必然整体落在区间内
  const inRange = (s) => s.start_ms >= startMs && s.end_ms <= endMs;
  const toRemove = draftSegments.filter(inRange);
  const toRestore = snapshotEntries
    .map((e, i) => ({
      snapshot_index: i + 1,
      start_ms: e.start_ms,
      end_ms: e.end_ms,
      text: e.text == null ? '' : String(e.text),
    }))
    .filter(inRange);

  // 替换后的完整时间线必须仍然合法（不信任快照内容，合并后全量校验）
  const removeIds = new Set(toRemove.map((s) => s.id));
  const merged = [
    ...draftSegments.filter((s) => !removeIds.has(s.id)),
    ...toRestore.map((e) => ({ id: `(恢复条目${e.snapshot_index})`, start_ms: e.start_ms, end_ms: e.end_ms })),
  ];
  const check = validateTimeline(merged, video.duration_ms);
  if (!check.ok) {
    throw new ApiError(422, 'invalid_timeline', `按该区间恢复后时间线不合法，未写入任何内容：${check.reason}`);
  }
  return { toRemove, toRestore };
}

router.post('/videos/:id(\\d+)/restore/preview', (req, res, next) => {
  try {
    const video = loadVideo(req.params.id);
    const { version, startMs, endMs } = readRestoreRange(req.body, video);
    const pub = loadPublication(video.id, version);
    const snapshot = JSON.parse(pub.snapshot);
    const draft = listSegments(video.id);
    const plan = planRestore(video, snapshot, draft, startMs, endMs);

    const token = makePreviewToken({
      videoId: video.id,
      mode: 'restore',
      draftHash: draftFingerprint(draft),
      extra: { ver: version, s: startMs, e: endMs },
    });

    res.json({
      version,
      start_ms: startMs,
      end_ms: endMs,
      duration_ms: video.duration_ms,
      // 并列对照：发布快照在区间内的片段（确认后恢复）vs 当前草稿在区间内的片段（确认后移除）
      to_restore: plan.toRestore,
      to_remove: plan.toRemove,
      token,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id(\\d+)/restore/confirm', (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    const video = loadVideo(videoId);
    const { version, startMs, endMs } = readRestoreRange(req.body, video);

    const token = readPreviewToken(req.body && req.body.token);
    if (!token || token.v !== video.id || token.m !== 'restore') {
      throw new ApiError(409, 'preview_required', '缺少有效的恢复预览令牌：请先调用恢复预览接口，再以预览返回的 token 确认');
    }
    if (token.ver !== version || token.s !== startMs || token.e !== endMs) {
      throw new ApiError(422, 'restore_params_changed',
        '确认的版本或区间与预览不一致，请按预览时的版本与区间确认，或重新预览；本次未写入任何内容');
    }
    const currentSegments = listSegments(video.id);
    if (token.d !== draftFingerprint(currentSegments)) {
      throw new ApiError(409, 'draft_changed',
        '预览之后草稿已被修改（可能是他人操作）。为避免覆盖更改，请重新预览后再确认；本次未写入任何内容',
        { current_segments: currentSegments });
    }

    // 事务内重新加载并完整复算恢复计划（不信任预览结果），整批原子写入
    const result = get().transaction(() => {
      const lockedVideo = get().prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
      if (!lockedVideo) throw new ApiError(404, 'not_found', `视频 #${videoId} 不存在`);
      const pub = get()
        .prepare('SELECT * FROM publications WHERE video_id = ? AND version = ?')
        .get(videoId, version);
      if (!pub) throw new ApiError(404, 'version_not_found', `已发布版本 v${version} 不存在`);
      const snapshot = JSON.parse(pub.snapshot);
      const draftRows = get()
        .prepare('SELECT * FROM segments WHERE video_id = ? ORDER BY start_ms, id')
        .all(videoId)
        .map(mapSegment);
      const plan = planRestore(lockedVideo, snapshot, draftRows, startMs, endMs);

      const ts = now();
      const del = get().prepare('DELETE FROM segments WHERE id = ? AND video_id = ?');
      for (const s of plan.toRemove) del.run(s.id, videoId);
      // 恢复片段作为新草稿片段写入：一律待审、修订号从 1 开始；区间外片段及其修订号不变
      const insert = get().prepare(
        `INSERT INTO segments (video_id, start_ms, end_ms, text, reviewed, revision, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`
      );
      const restored = plan.toRestore.map((e) => {
        const info = insert.run(videoId, e.start_ms, e.end_ms, e.text, ts);
        return mapSegment(get().prepare('SELECT * FROM segments WHERE id = ?').get(info.lastInsertRowid));
      });
      return { removed: plan.toRemove, restored };
    })();

    res.status(201).json({
      ok: true,
      version,
      start_ms: startMs,
      end_ms: endMs,
      removed_count: result.removed.length,
      restored_count: result.restored.length,
      removed: result.removed,
      restored: result.restored,
      segments: listSegments(video.id),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
