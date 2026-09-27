/* ===================================================================
   api/redis-client.js
   의존성 없는 Redis 클라이언트. 두 가지 접속 방식을 모두 지원한다.

   1) REST  : KV_REST_API_URL + KV_REST_API_TOKEN
              (= UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
              Upstash REST /pipeline 을 fetch 로 호출한다.

   2) TCP   : REDIS_URL / KV_URL  (redis:// 또는 rediss://)
              Vercel Marketplace 연동에 따라 REST 토큰 없이 접속 URL만
              주어지는 경우가 있어서, RESP 프로토콜을 직접 구현해 둔다.
              node:net / node:tls 만 쓰므로 npm 설치가 필요 없다.

   두 방식 모두 명령 여러 개를 한 번에 보내고(파이프라인) 결과 배열을 돌려준다.
   =================================================================== */

var net = require('node:net');
var tls = require('node:tls');

var REST_URL_VARS = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_API_URL'];
var REST_TOKEN_VARS = ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_API_TOKEN'];
var TCP_URL_VARS = ['REDIS_URL', 'KV_URL', 'UPSTASH_REDIS_URL'];

var TIMEOUT = 6000;

function pick(names) {
  for (var i = 0; i < names.length; i++) {
    var v = process.env[names[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

/** 어떤 방식으로 붙을 수 있는지 판단한다. 없으면 null. */
function detect() {
  var restUrl = pick(REST_URL_VARS);
  var restToken = pick(REST_TOKEN_VARS);
  if (restUrl && restToken) {
    return { mode: 'rest', url: restUrl.replace(/\/$/, ''), token: restToken };
  }
  var tcpUrl = pick(TCP_URL_VARS);
  if (tcpUrl && /^rediss?:\/\//.test(tcpUrl)) {
    return { mode: 'tcp', url: tcpUrl };
  }
  // https:// 형태의 REDIS_URL 만 있고 토큰이 없는 경우도 있다
  if (tcpUrl && /^https?:\/\//.test(tcpUrl) && restToken) {
    return { mode: 'rest', url: tcpUrl.replace(/\/$/, ''), token: restToken };
  }
  return null;
}

/** 값은 절대 노출하지 않고, 어떤 이름의 환경변수가 있는지만 알려준다. */
function envNamesSeen() {
  return Object.keys(process.env)
    .filter(function (k) { return /^(KV_|UPSTASH_|REDIS_)/.test(k); })
    .sort();
}

/* ------------------------- REST ------------------------- */

async function viaRest(conn, commands) {
  var res = await fetch(conn.url + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + conn.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error('REST ' + res.status + ' ' + text.slice(0, 160));
  }

  var out = await res.json();
  if (!Array.isArray(out)) throw new Error('REST 응답 형식이 예상과 다릅니다');

  return out.map(function (r) {
    if (r && r.error) throw new Error('Redis: ' + r.error);
    return r ? r.result : null;
  });
}

/* ------------------------- TCP (RESP) ------------------------- */

function encode(args) {
  var out = '*' + args.length + '\r\n';
  for (var i = 0; i < args.length; i++) {
    var s = String(args[i]);
    out += '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
  }
  return out;
}

/** 버퍼에서 응답 하나를 읽는다. 아직 덜 왔으면 null. */
function parseOne(buf, pos) {
  if (pos >= buf.length) return null;

  var type = buf[pos];
  var idx = buf.indexOf('\r\n', pos, 'utf8');
  if (idx < 0) return null;

  var line = buf.toString('utf8', pos + 1, idx);
  var next = idx + 2;

  if (type === 0x2b) return { value: line, next: next };                    // +OK
  if (type === 0x2d) return { value: new Error(line), next: next };         // -ERR
  if (type === 0x3a) return { value: Number(line), next: next };            // :123
  if (type === 0x5f) return { value: null, next: next };                    // _ (RESP3 null)

  if (type === 0x24) {                                                      // $bulk
    var len = parseInt(line, 10);
    if (len === -1) return { value: null, next: next };
    if (buf.length < next + len + 2) return null;
    return { value: buf.toString('utf8', next, next + len), next: next + len + 2 };
  }

  if (type === 0x2a) {                                                      // *array
    var n = parseInt(line, 10);
    if (n === -1) return { value: null, next: next };
    var arr = [];
    var p = next;
    for (var i = 0; i < n; i++) {
      var r = parseOne(buf, p);
      if (!r) return null;
      arr.push(r.value);
      p = r.next;
    }
    return { value: arr, next: p };
  }

  throw new Error('알 수 없는 RESP 타입: ' + String.fromCharCode(type));
}

function viaTcp(conn, commands) {
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new URL(conn.url); } catch (e) { return reject(new Error('REDIS_URL 형식이 올바르지 않습니다')); }

    var secure = u.protocol === 'rediss:';
    var host = u.hostname;
    var port = Number(u.port || 6379);
    var password = u.password ? decodeURIComponent(u.password) : '';
    var username = u.username ? decodeURIComponent(u.username) : '';

    var pre = [];
    if (password) pre.push(username ? ['AUTH', username, password] : ['AUTH', password]);

    var socket = secure
      ? tls.connect({ host: host, port: port, servername: host })
      : net.connect({ host: host, port: port });

    var buf = Buffer.alloc(0);
    var results = [];
    var wanted = pre.length + commands.length;
    var sent = false;
    var done = false;

    var timer = setTimeout(function () { finish(new Error('Redis 응답 시간 초과')); }, TIMEOUT);

    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) {}
      if (err) reject(err); else resolve(val);
    }

    function send() {
      if (sent) return;
      sent = true;
      var payload = '';
      pre.concat(commands).forEach(function (c) { payload += encode(c); });
      socket.write(payload);
    }

    socket.setTimeout(TIMEOUT);
    socket.on('timeout', function () { finish(new Error('Redis 연결 시간 초과')); });
    socket.on('error', function (e) { finish(new Error('Redis 연결 실패: ' + e.message)); });
    socket.on('close', function () { finish(new Error('Redis 연결이 끊겼습니다')); });
    socket.on(secure ? 'secureConnect' : 'connect', send);

    socket.on('data', function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      var pos = 0;
      while (results.length < wanted) {
        var r;
        try { r = parseOne(buf, pos); } catch (e) { return finish(e); }
        if (!r) break;
        results.push(r.value);
        pos = r.next;
      }
      if (pos > 0) buf = buf.subarray(pos);
      if (results.length < wanted) return;

      var out = results.slice(pre.length);
      for (var i = 0; i < out.length; i++) {
        if (out[i] instanceof Error) return finish(out[i]);
      }
      // AUTH 실패도 잡아준다
      for (var j = 0; j < pre.length; j++) {
        if (results[j] instanceof Error) return finish(results[j]);
      }
      finish(null, out);
    });
  });
}

/* ------------------------- 공개 API ------------------------- */

/** 명령 배열을 한 번에 실행하고 결과 배열을 돌려준다. */
async function run(commands) {
  var conn = detect();
  if (!conn) throw new Error('스토리지가 연결되어 있지 않습니다');
  return conn.mode === 'rest' ? viaRest(conn, commands) : viaTcp(conn, commands);
}

module.exports = {
  detect: detect,
  run: run,
  envNamesSeen: envNamesSeen,
  __internals: { encode: encode, parseOne: parseOne }
};
