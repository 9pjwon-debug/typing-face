/* ===================================================================
   /api/emotion  -  문장의 감정을 판단하는 서버리스 함수 (Vercel)

   POST /api/emotion {text}
     → { ok, configured:true, main, label, mix:{joy,sad,angry,surprise,fear,disgust,shy} }

   Google Gemini API(generateContent)를 fetch 로 직접 호출한다. npm 의존성은 없다.
   API 키는 서버에만 있고 브라우저로는 절대 나가지 않는다.

   환경변수
     GEMINI_API_KEY     (필수)  Google AI Studio 에서 무료로 발급. 없으면 configured:false 를
                                돌려주고, 페이지는 브라우저 안의 키워드 판단으로 동작한다.
     EMOTION_MODEL      (선택)  기본 gemini-3.5-flash-lite (무료 등급이 있는 빠른 모델)
     EMOTION_DAILY_LIMIT(선택)  하루 최대 Gemini 호출 수. 기본 1000. 넘으면 limited:true 를
                                돌려주고 페이지는 키워드 판단으로 버틴다.
                                Gemini 무료 한도(429)에 걸려도 똑같이 limited:true 로 처리한다.

   API 호출 줄이기
     - Redis 가 연결돼 있으면 같은 문장의 판단 결과를 7일간 캐시한다.
       캐시 적중은 Gemini 를 부르지 않고, 하루 호출 수에도 들어가지 않는다.
     - Redis 가 없으면 캐시와 하루 제한 없이 동작한다 (IP 분당 제한만).
   =================================================================== */

var crypto = require('node:crypto');
var client = require('./redis-client.js');

// keywords.js 의 EMOTIONS 와 같은 목록 (순서 무관)
var EMOTIONS = [
  'joy', 'excited', 'love', 'touched', 'proud', 'shy',
  'sad', 'sulky', 'tired', 'angry', 'contempt', 'disgust',
  'surprise', 'fear', 'confused', 'thinking'
];
var MAIN = EMOTIONS.concat(['neutral']);

var MODEL = process.env.EMOTION_MODEL || 'gemini-3.5-flash-lite';
var MAX_TEXT = 200;        // 한 번에 판단할 최대 글자 수
var RATE_LIMIT = 60;       // 분당 요청 수 (IP 기준, 인스턴스 메모리)
var TIMEOUT = 8000;
var CACHE_TTL = 7 * 24 * 3600;
var DAILY_LIMIT = Number(process.env.EMOTION_DAILY_LIMIT) || 1000;

var SYSTEM = [
  '너는 3D 얼굴 캐릭터의 표정을 정하는 감정 판단기다.',
  '사용자가 지금 입력 중인 한국어(또는 다른 언어) 문장을 읽고, 그 말을 하는 사람의 감정을 판단한다.',
  '문장이 아직 덜 끝났을 수 있으니 지금까지의 내용으로 가장 그럴듯하게 판단한다.',
  '긴 글이면 앞부분은 맥락으로만 쓰고, 가장 마지막 구절(방금 입력한 부분)의 감정을 판단한다.',
  '"근데/하지만/~는데/~지만" 같은 반전이나 "~지 않다/안 ~" 같은 부정이 나오면 뒤쪽 의미를 따른다.',
  '예: "나는 너가 사실 사랑" → joy, "나는 너가 사실 사랑스럽지 않다고" → angry 위주(못마땅), "어제는 행복했는데 오늘은 슬퍼" → sad.',
  'mix 는 각 감정의 세기(0~1)이며, 여러 감정이 섞일 수 있다. 감정이 없으면 모두 0 에 가깝게 둔다.',
  '감정 뜻: joy 기쁨·만족, excited 신남·기대·들뜸, love 애정·사랑 고백, touched 감동·고마움에 뭉클,',
  'proud 뿌듯·자랑·으쓱, shy 부끄러움·설렘·수줍음(칭찬받거나 고백받을 때), sad 슬픔·우울·상실,',
  'sulky 삐짐·서운함·억울함(토라짐), tired 피곤·졸림·지루함·귀찮음, angry 화남·짜증·분노,',
  'contempt 어이없음·비웃음·한심함, disgust 역겨움·불쾌, surprise 놀람·감탄, fear 두려움·걱정·긴장,',
  'confused 어리둥절·당황·이해 안 됨, thinking 고민·망설임·생각 중.',
  '가장 알맞은 1~2개를 크게 올리고 나머지는 0 에 가깝게 둔다.',
  'main 은 가장 두드러진 감정(감정이 거의 없으면 neutral), label 은 그 감정을 나타내는 한국어 한 단어(예: 기쁨, 설렘, 서운함, 짜증)다.',
  '다른 말 없이 JSON 하나만 출력한다. 형식:',
  '{"main":"' + MAIN.join('|') + '","label":"설렘","mix":{' + EMOTIONS.map(function (e) { return '"' + e + '":' + (e === 'shy' ? 0.8 : e === 'joy' ? 0.4 : 0); }).join(',') + '}}'
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
  return 'face:emo2:' + h;
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

/* ------------------------- Gemini 호출 ------------------------- */

/** 무료 한도 초과(429). 핸들러가 limited:true 로 바꿔서 돌려준다. */
function QuotaError() { this.name = 'QuotaError'; this.message = 'Gemini 무료 한도 초과'; }

async function callGemini(text, useSchema) {
  var generationConfig = { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1024 };
  if (useSchema) generationConfig.responseJsonSchema = SCHEMA;

  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
  try {
    var res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(MODEL) + ':generateContent',
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: text }] }],
          generationConfig: generationConfig
        })
      }
    );
    if (res.status === 429) throw new QuotaError();
    if (!res.ok) {
      var body = await res.text();
      var err = new Error('Gemini API ' + res.status + ' ' + body.slice(0, 160));
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function classify(text) {
  var data;
  try {
    data = await callGemini(text, true);
  } catch (err) {
    // 모델이 JSON 스키마 옵션을 받지 않으면(400) 프롬프트의 형식 안내만으로 한 번 더 시도
    if (err.status !== 400) throw err;
    data = await callGemini(text, false);
  }

  var cand = data && data.candidates && data.candidates[0];
  var parts = (cand && cand.content && cand.content.parts) || [];
  var raw = parts.map(function (p) { return p.text || ''; }).join('').trim();
  if (!raw) return normalize(null); // 안전 필터 등으로 비어 있으면 무표정

  var json = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return normalize(JSON.parse(json));
}

/* ------------------------- 진단 -------------------------
   브라우저로 /api/emotion?debug=1 을 열면 AI 가 왜 안 붙는지 알려준다.
   키 값은 절대 내보내지 않고, 있는지 여부와 앞 4글자 모양만 보여준다. */

function hintFor(status, message) {
  if (status === 400 && /API key/i.test(message)) return 'GEMINI_API_KEY 값이 올바르지 않습니다. AI Studio 에서 키를 다시 복사해 넣고 Redeploy 하세요.';
  if (status === 400 && /location|region|country/i.test(message)) return '이 지역에서는 Gemini 무료 API 를 쓸 수 없습니다. Vercel Settings → Functions → Region 을 미국(iad1 등)으로 바꿔보세요.';
  if (status === 400) return '요청 형식 문제입니다. EMOTION_MODEL 을 지우거나 다른 모델로 바꿔보세요.';
  if (status === 403) return '키가 거부됐습니다. 키가 삭제됐거나, Generative Language API 가 꺼져 있거나, 키에 API 제한이 걸려 있을 수 있습니다.';
  if (status === 404) return '모델 이름을 찾을 수 없습니다. Vercel 환경변수 EMOTION_MODEL 을 gemini-3.1-flash-lite 등 AI Studio 에 보이는 모델 이름으로 바꾸세요.';
  if (status === 429) return '무료 한도에 걸렸습니다. 잠시 후 다시 시도하거나 내일 다시 확인하세요.';
  return '잠시 후 다시 시도해보세요.';
}

async function diagnose(res) {
  var key = process.env.GEMINI_API_KEY || '';
  var out = {
    keySet: !!key,
    keyLooksLike: key ? key.slice(0, 4) + '... (' + key.length + '자)' : null,
    model: MODEL,
    redis: !!client.detect(),
    test: null,
    hint: null
  };
  if (!key) {
    out.hint = 'GEMINI_API_KEY 가 이 배포에 없습니다. Vercel Settings → Environment Variables 에 정확히 이 이름으로 넣고 ' +
      '(Production 체크), Deployments 에서 Redeploy 해야 적용됩니다. 비슷한 이름: ' +
      JSON.stringify(Object.keys(process.env).filter(function (k) { return /GEMINI|GOOGLE|API_KEY/i.test(k); }));
    return res.status(200).json(out);
  }
  try {
    var r = await classify('오늘 너무 행복해!');
    out.test = { ok: true, result: r };
    out.hint = '정상입니다. 페이지를 새로고침해서 다시 해보세요.';
  } catch (err) {
    var status = err instanceof QuotaError ? 429 : err.status || null;
    out.test = { ok: false, status: status, error: String(err && err.message || err).slice(0, 300) };
    out.hint = hintFor(status, out.test.error);
  }
  return res.status(200).json(out);
}

/* ------------------------- 핸들러 ------------------------- */

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET' && req.query && req.query.debug) {
    var dip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
    if (limited(dip)) return res.status(429).json({ ok: false, error: '잠시 후 다시 시도해주세요' });
    return diagnose(res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  if (!process.env.GEMINI_API_KEY) {
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
    if (err instanceof QuotaError) {
      return res.status(200).json({ ok: true, configured: true, limited: true });
    }
    return res.status(502).json({ ok: false, configured: true, error: String(err && err.message || err) });
  }
};

module.exports.__internals = { normalize: normalize, cacheKey: cacheKey, SCHEMA: SCHEMA, EMOTIONS: EMOTIONS };
