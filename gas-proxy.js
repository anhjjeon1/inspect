/**
 * 청개구리 사전점검 앱 — GAS 프록시 서버
 * ─────────────────────────────────────────
 * 기능 A: Gemini API 프록시 (API Key 서버 보관)
 * 기능 B: 이용권 코드 검증 (Google Sheets 연동)
 * 기능 C: 무료 사용량 서버 측 카운팅
 *
 * ★ 배포 방법 ★
 * 1. https://script.google.com 접속
 * 2. 새 프로젝트 생성
 * 3. 이 코드 전체를 붙여넣기
 * 4. 프로젝트 설정 → 스크립트 속성(Script Properties) 추가:
 *    - 키: GEMINI_KEY  / 값: (Gemini API Key)
 * 5. 배포 → 새 배포 → 웹 앱 → 액세스: 모든 사용자
 * 6. 배포 URL을 index.html의 GAS_URL에 입력
 *
 * ★ Google Sheets 준비 ★
 * 1. 새 Google Sheets 생성
 * 2. 시트1 이름: "코드목록" → 헤더: code | type | created | used | usedAt | usedBy
 * 3. 시트2 이름: "사용량"   → 헤더: date | fingerprint | count | mode | lastUsed
 * 4. 시트3 이름: "로그"     → 헤더: timestamp | action | fingerprint | detail
 * 5. 스크립트 속성에 추가:
 *    - 키: SHEET_ID  / 값: (Google Sheets ID - URL에서 /d/여기부분/edit)
 */

/* ── 설정 ── */
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    GEMINI_KEY: props.getProperty('GEMINI_KEY'),
    SHEET_ID:   props.getProperty('SHEET_ID'),
    GEMINI_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
  };
}

/* ── CORS 헤더 ── */
function makeResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ══════════════════════════════════════════════
   GET 요청 처리 (코드 검증, 사용량 조회)
   ══════════════════════════════════════════════ */
function doGet(e) {
  const action = (e.parameter.action || '').toLowerCase();

  try {
    switch (action) {
      case 'verify':
        return makeResponse(verifyCode(e.parameter));
      case 'usage':
        return makeResponse(getUsage(e.parameter));
      case 'ping':
        return makeResponse({ ok: true, ts: new Date().toISOString() });
      default:
        return makeResponse({ error: 'unknown action', valid_actions: ['verify','usage','ping'] });
    }
  } catch (err) {
    logAction('error', e.parameter.fp || '', err.toString());
    return makeResponse({ error: err.toString() });
  }
}

/* ══════════════════════════════════════════════
   POST 요청 처리 (AI 분석, 사용량 차감)
   ══════════════════════════════════════════════ */
function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  const action = (body.action || '').toLowerCase();

  try {
    switch (action) {
      case 'ai':
        return makeResponse(callGeminiAI(body));
      case 'use':
        return makeResponse(useQuota(body));
      default:
        return makeResponse({ error: 'unknown action', valid_actions: ['ai','use'] });
    }
  } catch (err) {
    logAction('error', body.fp || '', err.toString());
    return makeResponse({ error: err.toString() });
  }
}

/* ══════════════════════════════════════════════
   기능 A: Gemini API 프록시
   ══════════════════════════════════════════════ */
function callGeminiAI(body) {
  const config = getConfig();
  if (!config.GEMINI_KEY) return { error: 'GEMINI_KEY not configured' };

  const fp = body.fp || 'unknown';

  // Rate limit: 동일 fingerprint 분당 10회
  if (!checkRateLimit(fp, 10, 60)) {
    return { error: 'rate_limit', message: '요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.' };
  }

  // Gemini API 호출 (최대 2회 - 1차 분석 + 2차 검증)
  const results = [];
  const prompts = body.prompts || []; // [{prompt, images}]

  for (let i = 0; i < Math.min(prompts.length, 2); i++) {
    const p = prompts[i];
    const parts = [];

    // 텍스트 프롬프트
    parts.push({ text: p.prompt });

    // 이미지 추가 (base64)
    if (p.images && Array.isArray(p.images)) {
      for (const img of p.images) {
        if (img.data && img.mimeType) {
          parts.push({
            inlineData: {
              data: img.data,
              mimeType: img.mimeType
            }
          });
        }
      }
    }

    const payload = {
      contents: [{ parts: parts }]
    };

    const url = config.GEMINI_URL + '?key=' + config.GEMINI_KEY;
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();

    if (code === 429) {
      return { error: 'quota_exceeded', message: '오늘 전체 AI 분석 한도에 도달했습니다.' };
    }

    if (code !== 200) {
      return { error: 'gemini_error', code: code, message: res.getContentText().substring(0, 200) };
    }

    const json = JSON.parse(res.getContentText());
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    results.push(text);
  }

  logAction('ai', fp, 'prompts:' + prompts.length);
  return { ok: true, results: results };
}

/* ══════════════════════════════════════════════
   기능 B: 이용권 코드 검증
   ══════════════════════════════════════════════ */
function verifyCode(params) {
  const config = getConfig();
  if (!config.SHEET_ID) return { valid: false, message: '서버 설정 오류 (SHEET_ID)' };

  const code = (params.code || '').toUpperCase().trim();
  const fp = params.fp || 'unknown';
  const today = new Date().toISOString().split('T')[0];

  if (!code || code.length < 4) {
    return { valid: false, message: '유효하지 않은 코드입니다' };
  }

  const ss = SpreadsheetApp.openById(config.SHEET_ID);
  const sheet = ss.getSheetByName('코드목록');
  if (!sheet) return { valid: false, message: '서버 설정 오류 (시트)' };

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const codeCol = headers.indexOf('code');
  const usedCol = headers.indexOf('used');
  const usedAtCol = headers.indexOf('usedAt');
  const usedByCol = headers.indexOf('usedBy');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][codeCol]).toUpperCase().trim() === code) {
      // 코드 찾음
      const isUsed = data[i][usedCol] === true || data[i][usedCol] === 'TRUE' || data[i][usedCol] === true;

      if (isUsed) {
        // 이미 사용된 코드 - 같은 기기에서 같은 날이면 재활성화 허용
        const usedAt = String(data[i][usedAtCol]).split('T')[0];
        const usedByFp = String(data[i][usedByCol]);

        if (usedAt === today && usedByFp === fp) {
          logAction('verify_reactivate', fp, code);
          return { valid: true, message: '이용권 재활성화 (오늘 이미 등록된 기기)' };
        }

        return { valid: false, message: '이미 사용된 코드입니다' };
      }

      // 미사용 코드 → 사용 처리
      const row = i + 1; // 1-indexed
      sheet.getRange(row, usedCol + 1).setValue(true);
      sheet.getRange(row, usedAtCol + 1).setValue(new Date().toISOString());
      sheet.getRange(row, usedByCol + 1).setValue(fp);

      logAction('verify_ok', fp, code);
      return { valid: true, message: '인증 성공! 오늘 하루 이용권이 활성화되었습니다.' };
    }
  }

  logAction('verify_fail', fp, code);
  return { valid: false, message: '유효하지 않은 코드입니다' };
}

/* ══════════════════════════════════════════════
   기능 C: 무료 사용량 서버 측 카운팅
   ══════════════════════════════════════════════ */
function getUsage(params) {
  const config = getConfig();
  if (!config.SHEET_ID) return { error: 'SHEET_ID not configured' };

  const fp = params.fp || 'unknown';
  const mode = params.mode || 'free';
  const today = new Date().toISOString().split('T')[0];

  const ss = SpreadsheetApp.openById(config.SHEET_ID);
  const sheet = ss.getSheetByName('사용량');
  if (!sheet) return { error: '시트 없음' };

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dateCol = headers.indexOf('date');
  const fpCol = headers.indexOf('fingerprint');
  const countCol = headers.indexOf('count');

  // 오늘 + 같은 fingerprint 찾기
  for (let i = 1; i < data.length; i++) {
    const rowDate = data[i][dateCol];
    const formattedDate = rowDate instanceof Date
      ? rowDate.toISOString().split('T')[0]
      : String(rowDate);

    if (formattedDate === today && String(data[i][fpCol]) === fp) {
      const count = Number(data[i][countCol]) || 0;
      const limit = mode === 'paid' ? 100 : mode === 'pro' ? 50 : 3;
      return { count: count, limit: limit, remaining: Math.max(0, limit - count) };
    }
  }

  // 기록 없음 → 0회
  const limit = mode === 'paid' ? 100 : mode === 'pro' ? 50 : 3;
  return { count: 0, limit: limit, remaining: limit };
}

function useQuota(body) {
  const config = getConfig();
  if (!config.SHEET_ID) return { error: 'SHEET_ID not configured' };

  const fp = body.fp || 'unknown';
  const mode = body.mode || 'free';
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toTimeString().split(' ')[0];

  const ss = SpreadsheetApp.openById(config.SHEET_ID);
  const sheet = ss.getSheetByName('사용량');
  if (!sheet) return { error: '시트 없음' };

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const dateCol = headers.indexOf('date');
  const fpCol = headers.indexOf('fingerprint');
  const countCol = headers.indexOf('count');
  const modeCol = headers.indexOf('mode');
  const lastCol = headers.indexOf('lastUsed');

  // 오늘 + 같은 fingerprint 찾기
  for (let i = 1; i < data.length; i++) {
    const rowDate = data[i][dateCol];
    const formattedDate = rowDate instanceof Date
      ? rowDate.toISOString().split('T')[0]
      : String(rowDate);

    if (formattedDate === today && String(data[i][fpCol]) === fp) {
      const row = i + 1;
      const newCount = (Number(data[i][countCol]) || 0) + 1;
      sheet.getRange(row, countCol + 1).setValue(newCount);
      sheet.getRange(row, modeCol + 1).setValue(mode);
      sheet.getRange(row, lastCol + 1).setValue(now);

      const limit = mode === 'paid' ? 100 : mode === 'pro' ? 50 : 3;
      logAction('use', fp, mode + ':' + newCount);
      return { count: newCount, limit: limit, remaining: Math.max(0, limit - newCount) };
    }
  }

  // 새 기록 추가
  sheet.appendRow([today, fp, 1, mode, now]);
  const limit = mode === 'paid' ? 100 : mode === 'pro' ? 50 : 3;
  logAction('use', fp, mode + ':1');
  return { count: 1, limit: limit, remaining: Math.max(0, limit - 1) };
}

/* ══════════════════════════════════════════════
   Rate Limit (CacheService 기반)
   ══════════════════════════════════════════════ */
function checkRateLimit(fp, maxRequests, windowSec) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + fp;
  const raw = cache.get(key);
  const now = Date.now();

  if (!raw) {
    cache.put(key, JSON.stringify([now]), windowSec);
    return true;
  }

  let timestamps = JSON.parse(raw);
  const cutoff = now - (windowSec * 1000);
  timestamps = timestamps.filter(t => t > cutoff);

  if (timestamps.length >= maxRequests) {
    return false;
  }

  timestamps.push(now);
  cache.put(key, JSON.stringify(timestamps), windowSec);
  return true;
}

/* ══════════════════════════════════════════════
   로그 기록
   ══════════════════════════════════════════════ */
function logAction(action, fp, detail) {
  try {
    const config = getConfig();
    if (!config.SHEET_ID) return;
    const ss = SpreadsheetApp.openById(config.SHEET_ID);
    const sheet = ss.getSheetByName('로그');
    if (!sheet) return;
    sheet.appendRow([new Date().toISOString(), action, fp, detail]);

    // 로그 시트 1000행 초과 시 오래된 것 삭제
    const lastRow = sheet.getLastRow();
    if (lastRow > 1100) {
      sheet.deleteRows(2, lastRow - 1000);
    }
  } catch (e) {
    // 로그 실패는 무시
  }
}

/* ══════════════════════════════════════════════
   유틸: 초기 코드 대량 생성 (1회 실행)
   ══════════════════════════════════════════════
   GAS 에디터에서 generateCodes() 직접 실행하면
   코드목록 시트에 FROG001~FROG200 자동 생성
   ══════════════════════════════════════════════ */
function generateCodes() {
  const config = getConfig();
  const ss = SpreadsheetApp.openById(config.SHEET_ID);
  const sheet = ss.getSheetByName('코드목록');

  const today = new Date().toISOString().split('T')[0];
  const rows = [];

  for (let i = 1; i <= 200; i++) {
    const code = 'FROG' + String(i).padStart(3, '0');
    rows.push([code, 'paid', today, false, '', '']);
  }

  // 헤더 다음 행부터 삽입
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, 6).setValues(rows);

  Logger.log('Generated ' + rows.length + ' codes (FROG001~FROG200)');
}
