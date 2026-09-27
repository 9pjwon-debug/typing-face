/* ===================================================================
   face.js  -  글자를 칠 때마다 표정이 바뀌는 3D 얼굴

   입력 ─(키워드 판단으로 즉시 반응, 한글 조합이 끝나고 0.6초 멈추면)→ /api/emotion (Gemini)
        → {mix:{joy,sad,...}} → 감정별 표정 프리셋을 섞어 blendshape 목표값 계산
        → 매 프레임 목표값으로 부드럽게 이동

   서버에 API 키가 없으면 브라우저 안의 키워드 판단(localGuess)으로 대신한다.
   첫 화면에서 사진을 고르면 photo.js 가 사진 속 얼굴을 3D 얼굴에 입힌다.
   얼굴 모델: models/face.glb (three.js 예제 facecap.glb, ARKit 52 blendshape)
   =================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EMOTIONS, localGuess } from './keywords.js';
import { preloadLandmarker, fileToCanvas, detectFace, applyPhoto, measureDummy } from './photo.js';

const COLORS = {
  joy: '#ffd84d', sad: '#6aa8ff', angry: '#ff5a4f', surprise: '#ff9f43',
  fear: '#a98bff', disgust: '#7bd88f', shy: '#ff8fb8', neutral: '#8c909a'
};

/* ------------------------- 표정 프리셋 -------------------------
   이름은 ARKit blendshape 기준. 좌우가 있는 것은 _L/_R 을 붙이지 않고 쓰면
   양쪽에 같은 값이 들어간다. blush 는 볼 홍조(모델 밖 효과). */
const PRESETS = {
  joy: {
    mouthSmile: 0.95, cheekSquint: 0.7, eyeSquint: 0.55, mouthDimple: 0.3,
    mouthUpperUp: 0.25, jawOpen: 0.12, browOuterUp: 0.15, blush: 0.5
  },
  sad: {
    mouthFrown: 0.85, browInnerUp: 0.95, mouthLowerDown: 0.15, mouthRollLower: 0.2,
    eyeSquint: 0.2, eyeLookDown: 0.35
  },
  angry: {
    browDown: 1, noseSneer: 0.9, eyeSquint: 0.7, mouthPress: 0.8,
    mouthFrown: 0.6, mouthUpperUp: 0.25, jawForward: 0.25
  },
  surprise: {
    jawOpen: 0.55, browInnerUp: 0.9, browOuterUp: 0.9, eyeWide: 0.9, mouthFunnel: 0.3
  },
  fear: {
    browInnerUp: 1, browOuterUp: 0.3, eyeWide: 0.75, mouthStretch: 0.6, jawOpen: 0.15
  },
  disgust: {
    noseSneer: 1, mouthUpperUp: 0.6, browDown: 0.5, eyeSquint: 0.5,
    mouthFrown: 0.3, mouthLeft: 0.25
  },
  shy: {
    mouthSmile: 0.45, eyeLookDown: 0.6, eyeSquint: 0.3, browInnerUp: 0.3,
    mouthPucker: 0.2, blush: 1
  }
};

/* ------------------------- 3D 장면 ------------------------- */

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);

scene.add(new THREE.HemisphereLight(0xffffff, 0x303038, 1.4));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 2, 3);
scene.add(key);
const rim = new THREE.DirectionalLight(0xbcd0ff, 1.2);
rim.position.set(-2, 1, -2);
scene.add(rim);

const pivot = new THREE.Group(); // 고개 움직임용
scene.add(pivot);

const skin = new THREE.MeshStandardMaterial({ color: 0xc9cbd0, roughness: 0.75 });
const eyeMat = new THREE.MeshStandardMaterial({ color: 0x3a3c42, roughness: 0.3 });
const teethMat = new THREE.MeshStandardMaterial({ color: 0xf1ede4, roughness: 0.5 });

let face = null;        // blendshape 가 있는 mesh
const eyes = [];
const teeth = [];
let resolveModel;
const modelReady = new Promise((r) => { resolveModel = r; });
let blushSprites = [];
const target = {};      // 목표 blendshape 값 (이름 → 0~1)
let blushTarget = 0;
let blushNow = 0;

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function makeBlushTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,110,130,0.9)');
  grad.addColorStop(1, 'rgba(255,110,130,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.load('models/face.glb', (gltf) => {
  const root = gltf.scene;

  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = (o.name + ' ' + (o.parent && o.parent.name)).toLowerCase();
    if (o.morphTargetDictionary) {
      face = o;
      o.material = skin;
    } else if (name.includes('eye')) {
      o.material = eyeMat;
      eyes.push(o);
    } else if (name.includes('teeth')) {
      o.material = teethMat;
      teeth.push(o);
    } else {
      o.material = skin;
    }
  });

  // 머리를 원점에 두고 카메라 거리를 맞춘다
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  pivot.add(root);

  const fit = size.y / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(0, size.y * 0.02, fit * 1.15);
  camera.lookAt(0, 0, 0);

  // 볼 홍조: 얼굴 앞쪽 양 볼 위치에 스프라이트
  const tex = makeBlushTexture();
  for (const side of [-1, 1]) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false
    }));
    s.position.set(side * size.x * 0.2, -size.y * 0.07, size.z * 0.45);
    s.scale.setScalar(size.x * 0.22);
    pivot.add(s);
    blushSprites.push(s);
  }

  document.getElementById('loading').hidden = true;
  resolveModel();
}, undefined, (err) => {
  document.getElementById('loading').textContent = '얼굴 모델을 불러오지 못했어요';
  console.error(err);
});

/* ------------------------- 감정 → 표정 ------------------------- */

function addShape(out, name, v) {
  if (name === 'blush') return;
  const dict = face && face.morphTargetDictionary;
  const names = dict && !(name in dict) ? [name + '_L', name + '_R'] : [name];
  for (const n of names) out[n] = Math.min(1, (out[n] || 0) + v);
}

function applyMix(mix) {
  const out = {};
  let blush = 0;
  for (const e of EMOTIONS) {
    const w = mix[e] || 0;
    if (!w) continue;
    for (const [name, v] of Object.entries(PRESETS[e])) {
      if (name === 'blush') blush = Math.max(blush, v * w);
      else addShape(out, name, v * w);
    }
  }
  for (const k in target) target[k] = 0;
  Object.assign(target, out);
  blushTarget = blush;
}

/* ------------------------- 살아있는 느낌 ------------------------- */

let blinkUntil = 0;
let nextBlink = performance.now() + 2000;

function frame(now) {
  resize();

  if (face) {
    // 눈 깜빡임
    if (now > nextBlink) {
      blinkUntil = now + 140;
      nextBlink = now + 2000 + Math.random() * 4000;
    }
    const blink = now < blinkUntil ? 1 : 0;

    const dict = face.morphTargetDictionary;
    const inf = face.morphTargetInfluences;
    for (const name in dict) {
      let goal = target[name] || 0;
      if (name === 'eyeBlink_L' || name === 'eyeBlink_R') goal = Math.max(goal, blink);
      const speed = name.startsWith('eyeBlink') ? 0.5 : 0.22;
      inf[dict[name]] += (goal - inf[dict[name]]) * speed;
    }
  }

  blushNow += (blushTarget - blushNow) * 0.15;
  for (const s of blushSprites) s.material.opacity = blushNow * 0.55;

  // 숨쉬기 + 살짝 고개 흔들기
  const t = now / 1000;
  pivot.rotation.y = Math.sin(t * 0.5) * 0.06;
  pivot.rotation.x = Math.sin(t * 0.7) * 0.025;
  pivot.position.y = Math.sin(t * 1.6) * 0.002;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ------------------------- 입력 처리 ------------------------- */

const input = document.getElementById('text');
const status = document.getElementById('status');
const statusText = document.getElementById('status-text');
const modeText = document.getElementById('mode');

/* API 호출 줄이기
   - 키워드 판단으로 표정을 먼저 바로 바꾸고, AI 는 타이핑이 0.6초 멈췄을 때만 부른다
   - 공백만 바뀐 경우, 한 번 판단한 문장은 다시 부르지 않는다 (이 탭 안 캐시)
   - 2글자 미만은 AI 를 부르지 않는다
   - 서버에 키가 없거나 하루 사용량을 넘기면 이 탭에서는 더 이상 부르지 않는다 */
const AI_DELAY = 600;
const MIN_CHARS = 2;

let composing = false;
let timer = 0;
let ctrl = null;
let aiOffUntil = 0;        // 이 시각까지는 키워드 판단만 (Infinity = 이 탭에서 계속)
let lastText = '';
const cache = new Map();   // 문장 → 판단 결과

function norm(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function remember(text, result) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(text, result);
}

function setStatus(kind, text, color) {
  status.className = kind;
  statusText.textContent = text;
  status.querySelector('.dot').style.background = color || '';
}

/* 표정 유지: 새 판단에서 감정이 나왔을 때만 표정을 바꾼다.
   판단 결과가 무표정(감정 없음)이면 가장 최근 표정을 그대로 둔다.
   무표정으로 돌아가는 때: 입력을 전부 지웠을 때, 지우기 버튼, 한동안(IDLE_RESET) 입력이 없을 때. */
const IDLE_RESET = 10000;
let shown = null;          // 지금 얼굴에 떠 있는 판단 결과 (null = 무표정)
let idleTimer = 0;

function restartIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(resetFace, IDLE_RESET);
}

function show(result) {
  if (result.main !== 'neutral') {
    shown = result;
    applyMix(result.mix);
    restartIdle();
  }
  showStatus();
}

function showStatus() {
  if (shown) setStatus('done', `지금 ${shown.label}`, COLORS[shown.main]);
  else setStatus('', '입력을 기다리는 중');
}

function resetFace() {
  shown = null;
  applyMix({});
  showStatus();
}

function schedule() {
  clearTimeout(timer);
  restartIdle();
  const text = norm(input.value);
  if (!text) {
    ctrl && ctrl.abort();
    lastText = '';
    resetFace();
    return;
  }
  if (text === lastText) return;

  if (cache.has(text)) {
    lastText = text;
    return show(cache.get(text));
  }

  const guess = localGuess(text);
  if (aiOff() || text.length < MIN_CHARS) {
    lastText = text;
    return show(guess);
  }

  // AI 를 기다리는 동안에도 표정은 바로 반응하게 키워드 판단을 먼저 보여준다
  // (감정이 안 잡히면 최근 표정 유지)
  if (guess.main !== 'neutral') {
    shown = guess;
    applyMix(guess.mix);
  }
  setStatus('busy', '더미가 판단하는 중...', shown ? COLORS[shown.main] : '');
  timer = setTimeout(() => judge(text), AI_DELAY);
}

function aiOff() {
  return performance.now() < aiOffUntil;
}

function giveUpAi(message, text, ms) {
  aiOffUntil = performance.now() + ms;
  modeText.textContent = message;
  show(localGuess(text));
}

async function judge(text) {
  lastText = text;
  if (cache.has(text)) return show(cache.get(text));
  if (aiOff()) return show(localGuess(text));

  ctrl && ctrl.abort();
  ctrl = new AbortController();
  try {
    const res = await fetch('/api/emotion', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (data.configured === false) {
      return giveUpAi('서버에 GEMINI_API_KEY 가 없어 간단한 키워드 판단으로 동작 중', text, Infinity);
    }
    if (data.limited) {
      // 무료 한도는 분당 제한도 있어서, 1분 쉬었다가 다시 AI 를 시도한다
      return giveUpAi('AI 무료 한도에 걸려 잠시 키워드 판단으로 동작 중', text, 60000);
    }
    if (!data.ok) throw new Error(data.error || res.status);
    modeText.textContent = '';
    remember(text, data);
    show(data);
  } catch (err) {
    if (err.name === 'AbortError') return;
    // 서버가 없거나(로컬 파일로 연 경우) 일시 오류면 이번만 키워드 판단
    modeText.textContent = `AI 판단 실패(${err.message}) → 키워드 판단으로 대신했어요. 원인: /api/emotion?debug=1`;
    show(localGuess(text));
  }
}

input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; schedule(); });
input.addEventListener('input', (e) => {
  // 한글 조합 중("했" 을 치는 도중)에는 보내지 않는다
  if (composing || e.isComposing) return;
  schedule();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    clearTimeout(timer);
    const text = norm(input.value);
    if (text && text !== lastText) judge(text);
  }
});

document.getElementById('panel').addEventListener('submit', (e) => e.preventDefault());
document.getElementById('clear').addEventListener('click', () => {
  input.value = '';
  schedule();
  resetFace();
  input.focus();
});

/* ------------------------- 첫 화면: 사진 입히기 ------------------------- */

const intro = document.getElementById('intro');
const photoInput = document.getElementById('photo');
const introMsg = document.getElementById('intro-msg');
const removePhotoBtn = document.getElementById('remove-photo');
let undoPhoto = null;

const changePhotoBtn = document.getElementById('change-photo');
const originalBtn = document.getElementById('original-face');

/** 얼굴 위 버튼 글자/표시를 사진 상태에 맞춘다 */
function updateTools() {
  changePhotoBtn.textContent = undoPhoto ? '📷 사진 바꾸기' : '📷 내 사진 입히기';
  originalBtn.hidden = !undoPhoto;
}

function useOriginalFace() {
  if (undoPhoto) undoPhoto();
  undoPhoto = null;
  updateTools();
}

function openIntro() {
  intro.hidden = false;
  document.body.classList.add('intro-open');
  removePhotoBtn.hidden = !undoPhoto;
  introMsg.textContent = '';
  introMsg.className = '';
}

function closeIntro() {
  updateTools();
  intro.hidden = true;
  document.body.classList.remove('intro-open');
  input.focus({ preventScroll: true });
}

function setIntroMsg(text, kind) {
  introMsg.textContent = text;
  introMsg.className = kind || '';
}

/** 사진(canvas) → 얼굴 찾기 → 더미 측정 → 입히기. 공통 처리 */
async function usePhoto(getCanvas) {
  intro.classList.add('working');
  setIntroMsg('얼굴 찾는 중...', 'busy');
  try {
    const [canvasImg] = await Promise.all([getCanvas(), modelReady]);
    const lm = await detectFace(canvasImg);
    if (!lm) {
      setIntroMsg('얼굴을 찾지 못했어요. 얼굴이 크게 나온 정면 사진으로 다시 해보세요.', 'error');
      return;
    }
    if (eyes.length !== 2) throw new Error('3D 얼굴의 눈을 찾지 못했어요');
    if (undoPhoto) undoPhoto();
    undoPhoto = null;
    let dummy = null;
    try {
      dummy = await measureDummy({ renderer, scene, camera, pivot, head: face, eyes, hide: blushSprites });
    } catch (err) {
      console.warn('더미 측정 실패, 5점 맞춤으로 대신합니다', err);
    }
    if (!dummy) console.warn('더미 얼굴 점을 찾지 못해 5점 맞춤으로 대신합니다');
    else console.info('더미 얼굴 점 측정 완료: 약 100점 맞춤');
    undoPhoto = applyPhoto({ pivot, head: face, eyes, teeth }, canvasImg, lm, dummy);
    closeIntro();
  } catch (err) {
    console.error(err);
    setIntroMsg('사진을 처리하지 못했어요. 다른 사진으로 해보거나 잠시 후 다시 시도해주세요.', 'error');
  } finally {
    intro.classList.remove('working');
  }
}

// 사진 고르는 창이 열리는 동안 얼굴 인식 도구를 미리 받아둔다
document.getElementById('photo-btn').addEventListener('click', () => {
  preloadLandmarker().catch(() => {});
});

photoInput.addEventListener('change', () => {
  const file = photoInput.files && photoInput.files[0];
  photoInput.value = '';
  if (file) usePhoto(() => fileToCanvas(file));
});

/* ------------------------- 가이드 카메라 ------------------------- */

const cam = document.getElementById('camera');
const camVideo = document.getElementById('cam-video');
const camBox = document.getElementById('cam-box');
let camStream = null;
let camFacing = 'user';

async function startCamera() {
  stopCamera();
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false
  });
  camVideo.srcObject = camStream;
  camVideo.classList.toggle('mirror', camFacing === 'user');
  await camVideo.play();
}

function stopCamera() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  camVideo.srcObject = null;
}

function closeCamera() {
  stopCamera();
  cam.hidden = true;
}

document.getElementById('camera-btn').addEventListener('click', async () => {
  preloadLandmarker().catch(() => {});
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setIntroMsg('이 브라우저에서는 카메라를 쓸 수 없어요. "앨범에서 고르기"를 이용해주세요.', 'error');
    return;
  }
  cam.hidden = false;
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    closeCamera();
    setIntroMsg('카메라를 켜지 못했어요. 카메라 권한을 허용하거나 "앨범에서 고르기"를 이용해주세요.', 'error');
  }
});

document.getElementById('cam-cancel').addEventListener('click', closeCamera);

document.getElementById('cam-flip').addEventListener('click', async () => {
  camFacing = camFacing === 'user' ? 'environment' : 'user';
  try { await startCamera(); } catch (err) { console.error(err); }
});

// 화면에 보이는 영역(가이드 기준)만 잘라서 찍는다. 셀카는 보이는 그대로(좌우 반전) 저장
document.getElementById('cam-shot').addEventListener('click', () => {
  const vw = camVideo.videoWidth;
  const vh = camVideo.videoHeight;
  if (!vw || !vh) return;
  const bw = camBox.clientWidth;
  const bh = camBox.clientHeight;
  const scale = Math.max(bw / vw, bh / vh);
  const sw = bw / scale;
  const sh = bh / scale;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;
  const out = Math.min(1, 1024 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * out);
  c.height = Math.round(sh * out);
  const g = c.getContext('2d');
  if (camFacing === 'user') {
    g.translate(c.width, 0);
    g.scale(-1, 1);
  }
  g.drawImage(camVideo, sx, sy, sw, sh, 0, 0, c.width, c.height);
  closeCamera();
  usePhoto(async () => c);
});

document.getElementById('skip').addEventListener('click', closeIntro);
changePhotoBtn.addEventListener('click', openIntro);
originalBtn.addEventListener('click', useOriginalFace);
removePhotoBtn.addEventListener('click', () => {
  useOriginalFace();
  closeIntro();
});

// 디버깅용: 콘솔에서 Face.mix({joy:1}) 처럼 표정을 직접 줄 수 있다
window.Face = { mix: applyMix, guess: localGuess };
