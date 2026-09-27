/* ===================================================================
   /api/emotion  -  문장의 감정을 판단하는 서버리스 함수 (Vercel)

   POST /api/emotion {text}
     → { ok, configured:true, main, label, mix:{joy,sad,angry,surprise,fear,disgust,shy} }

   Claude API(Messages)를 fetch 로 직접 호출한다. npm 의존성은 없다.
   API 키는 서버에만 있고 브라우저로는 절대 나가지 않는다.

   환경변수
     ANTHROPIC_API_KEY  (필수)  없으면 configured:false 를 돌려주고,
                                페이지는 브라우저 안의 키워드 판단으로 동작한다.
     EMOTION_MODEL      (선택)  기본 claude-haiku-4-5 (타이핑마다 부르므로 빠른 모델)
     EMOTION_DAILY_LIMIT(선택)  하루 최대 Claude 호출 수. 기본 1000. 넘으면 limited:true 를
                                돌려주고 페이지는 키워드 판단으로 버틴다 (요금 폭주 방지).

   API 호출 줄이기
     - Redis 가 연결돼 있으면 같은 문장의 판단 결과를 7일간 캐시한다.
       캐시 적중은 Claude 를 부르지 않고, 하루 호출 수에도 들어가지 않는다.
     - Redis 가 없으면 캐시와 하루 제한 없이 동작한다 (IP 분당 제한만).
   =================================================================== */

var crypto = require('node:crypto');
var client = require('./redis-client.js');

var EMOTIONS = ['joy', 'sad', 'angry', 'surprise', 'fear', 'disgust', 'shy'];
var MAIN = EMOTIONS.concat(['neutral']);

var MODEL = process.env.EMOTION_MODEL || 'claude-haiku-4-5';
var MAX_TEXT = 200;        // 한 번에 판단할 최대 글자 수
var RATE_LIMIT = 60;       // 분당 요청 수 (IP 기준, 인스턴스 메모리)
var TIMEOUT = 8000;
var CACHE_TTL = 7 * 24 * 3600;
var DAILY_LIMIT = Number(process.env.EMOTION_DAILY_LIMIT) || 1000;

var SYSTEM = [
  '너는 3D 얼굴 캐릭터의 표정을 정하는 감정 판단기다.',
  '사용자가 지금 입력 중인 한국어(또는 다른 언어) 문장을 읽고, 그 말을 하는 사람의 감정을 판단한다.',
  '문장이 아직 덜 끝났을 수 있으니 지금까지의 내용으로 가장 그럴듯하게 판단한다.',
  'mix 는 각 감정의 세기(0~1)이며, 여러 감정이 섞일 수 있다. 감정이 없으면 모두 0 에 가깝게 둔다.',
  'shy 는 부끄러움·설렘·수줍음이다. 칭찬을 받거나 고백하는 말이면 joy 와 shy 를 함께 올린다.',
  'main 은 가장 두드러진 감정(감정이 거의 없으면 neutral), label 은 그 감정을 나타내는 한국어 한 단어(예: 기쁨, 설렘, 서운함, 짜증)다.'
].join('\n');

var SCHEMA = {
  type: 'object',
  properties: {
    main: { type: 'string', enum: MAIN },
    label: { type: 'string' },
    mix: {
      type: 'object',
      properties: EMOTIONS.reduce(function (o, k) { o[k] = { type: 'number' }; return o; }, {}),
      required: EMOTIONS,
      additionalProperties: false
    }
  },
  required: ['main', 'label', 'mix'],
  additionalProperties: false
};

/* ------------------------- 요청 제한 ------------------------- */

var hits = new Map(); // ip -> [timestamp...]

function limited(ip) {
  var now = Date.now();
  var list = (hits.get(ip) || []).filter(function (t) { return now - t < 60000; });
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_LIMIT;
}

/* ------------------------- 캐시 / 하루 제한 (Redis 선택) ------------------------- */

function cacheKey(text) {
  var h = crypto.createHash('sha256').update(MODEL + '\n' + text).digest('hex').slice(0, 32);
  return 'face:emo:' + h;
}

function dayKey() {
  return 'face:emo:day:' + new Date().toISOString().slice(0, 10);
}

/** 저장소 오류는 삼킨다. 캐시가 죽어도 판단은 계속되어야 한다. */
async function redisSafe(commands) {
  if (!client.detect()) return null;
  try { return await client.run(commands); } catch (e) { return null; }
}

async function cacheGet(text) {
  var out = await redisSafe([['GET', cacheKey(text)]]);
  if (!out || !out[0]) return null;
  try { return normalize(JSON.parse(out[0])); } catch (e) { return null; }
}

function cacheSet(text, result) {
  return redisSafe([['SET', cacheKey(text), JSON.stringify(result), 'EX', String(CACHE_TTL)]]);
}

/** 오늘 호출 수를 1 늘리고, 제한을 넘었으면 true. Redis 가 없으면 항상 false. */
async function overDaily() {
  var key = dayKey();
  var out = await redisSafe([['INCR', key], ['EXPIRE', key, String(2 * 24 * 3600)]]);
  return !!out && Number(out[0]) > DAILY_LIMIT;
}

/* ------------------------- 응답 정리 ------------------------- */

function clamp01(v) {
  v = Number(v);
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function normalize(raw) {
  var mix = {};
  EMOTIONS.forEach(function (k) { mix[k] = clamp01(raw && raw.mix && raw.mix[k]); });
  var main = MAIN.indexOf(raw && raw.main) >= 0 ? raw.main : 'neutral';
  var label = typeof (raw && raw.label) === 'string' ? raw.label.trim().slice(0, 8) : '';
  return { main: main, label: label || '무표정', mix: mix };
}

/* ------------------------- Claude 호출 ------------------------- */

async function classify(text) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
  try {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: text }]
      })
    });

    if (!res.ok) {
      var body = await res.text();
      throw new Error('Claude API ' + res.status + ' ' + body.slice(0, 160));
    }

    var msg = await res.json();
    if (msg.stop_reason === 'refusal') return normalize(null);
    var block = (msg.content || []).find(function (b) { return b.type === 'text'; });
    if (!block) throw new Error('응답에 텍스트가 없습니다');
    return normalize(JSON.parse(block.text));
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- 핸들러 ------------------------- */

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: true, configured: false });
  }

  var text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(-MAX_TEXT);
  if (!text) {
    return res.status(200).json(Object.assign({ ok: true, configured: true }, normalize(null)));
  }

  var ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (limited(ip)) {
    return res.status(429).json({ ok: false, configured: true, error: '잠시 후 다시 시도해주세요' });
  }

  try {
    var hit = await cacheGet(text);
    if (hit) return res.status(200).json(Object.assign({ ok: true, configured: true, cached: true }, hit));

    if (await overDaily()) {
      return res.status(200).json({ ok: true, configured: true, limited: true });
    }

    var out = await classify(text);
    await cacheSet(text, out);
    return res.status(200).json(Object.assign({ ok: true, configured: true }, out));
  } catch (err) {
    return res.status(502).json({ ok: false, configured: true, error: String(err && err.message || err) });
  }
};

module.exports.__internals = { normalize: normalize, cacheKey: cacheKey, SCHEMA: SCHEMA, EMOTIONS: EMOTIONS };
