/* ===================================================================
   photo.js  -  사진 속 얼굴을 3D 더미 얼굴에 입힌다

   1) MediaPipe Face Landmarker 로 사진에서 얼굴 점 478개를 찾는다 (브라우저 안에서만, 서버 전송 없음)
   2) 더미 얼굴을 정면으로 한 장 렌더링해서 같은 도구로 얼굴 점을 찾는다 (measureDummy)
   3) 눈 윤곽·눈썹·코·입술·얼굴 윤곽 약 100점을 짝지어 thin-plate spline 으로
      "더미 화면 좌표 → 사진 좌표" 변환을 만든다. 짝지은 점에서는 정확히 맞으므로
      사진의 눈이 더미의 눈구멍에, 입술이 입술에 딱 맞는다.
      (더미 측정에 실패하면 눈·코·입·턱 5점 affine 으로 대신한다)
   3') 3D 얼굴의 각 꼭짓점을 그 변환으로 사진 위에 옮겨 텍스처 좌표(uv)로 쓴다
      → 사진이 얼굴 표면에 붙어서, 표정(blendshape)이 움직이면 사진도 같이 움직인다
   4) 사진의 얼굴 윤곽 바깥(머리·귀·옆면)은 사진에서 뽑은 피부색으로 자연스럽게 섞는다

   MediaPipe 코드는 사진을 고를 때 처음 불러온다 (그냥 시작하면 받지 않는다).
   =================================================================== */

import * as THREE from 'three';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const MODEL = 'models/face_landmarker.task';
const MAX_SIDE = 1024;

// MediaPipe 얼굴 윤곽(FACE_OVAL) 순서
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

// 더미 ↔ 사진을 짝지을 점들 (MediaPipe 얼굴 점 번호)
const CONTROL = [...new Set([
  // 눈 윤곽 (양쪽)
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
  // 눈썹
  70, 63, 105, 66, 107, 336, 296, 334, 293, 300,
  // 코
  1, 2, 4, 5, 6, 168, 195, 98, 327, 129, 358,
  // 입술
  61, 291, 0, 17, 13, 14, 37, 267, 84, 314, 78, 308, 40, 270, 91, 321,
  // 볼
  50, 280, 205, 425,
  // 얼굴 윤곽 (한 칸씩 건너뛰며)
  ...OVAL.filter((_, i) => i % 2 === 0)
])];

/* ------------------------- 얼굴 점 찾기 ------------------------- */

let landmarkerPromise = null;

/** 사진 버튼을 누르는 순간 미리 불러두면 사진 고르는 동안 준비가 끝난다 */
export function preloadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, FaceLandmarker } = await import(`${MP}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL },
        runningMode: 'IMAGE',
        numFaces: 1
      });
    })().catch((err) => {
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

/** 파일 → 긴 변이 1024 이하인 canvas (사진 회전 정보 반영) */
export async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 얼굴 점을 픽셀 좌표로. 얼굴이 없으면 null */
export async function detectFace(canvas) {
  const landmarker = await preloadLandmarker();
  const result = landmarker.detect(canvas);
  const pts = result.faceLandmarks && result.faceLandmarks[0];
  if (!pts) return null;
  return pts.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));
}

/* ------------------------- 계산 도구 ------------------------- */

function avg(...ps) {
  const n = ps.length;
  return { x: ps.reduce((s, p) => s + p.x, 0) / n, y: ps.reduce((s, p) => s + p.y, 0) / n };
}

/** src[i] → dst[i] 를 가장 잘 맞추는 affine (최소제곱). 반환: (x,y) → {x,y} */
function fitAffine(src, dst) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  src.forEach((s, i) => {
    const r = [s.x, s.y, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b];
      bu[a] += r[a] * dst[i].x;
      bv[a] += r[a] * dst[i].y;
    }
  });
  const pu = solve3(M, bu);
  const pv = solve3(M, bv);
  return (x, y) => ({ x: pu[0] * x + pu[1] * y + pu[2], y: pv[0] * x + pv[1] * y + pv[2] });
}

/** 가우스 소거 (여러 우변을 한 번에) */
function solve(A, rhs) {
  const n = A.length;
  const m = A.map((row, i) => [...row, ...rhs.map((b) => b[i])]);
  const k = rhs.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const piv = m[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / piv;
      if (!f) continue;
      for (let j = c; j < n + k; j++) m[r][j] -= f * m[c][j];
    }
  }
  return rhs.map((_, t) => m.map((row, i) => row[n + t] / (row[i] || 1e-12)));
}

/** thin-plate spline: src[i] → dst[i] 를 정확히 지나는 부드러운 변환 */
function fitTPS(src, dst) {
  const n = src.length;
  const cx = src.reduce((s, p) => s + p.x, 0) / n;
  const cy = src.reduce((s, p) => s + p.y, 0) / n;
  const spread = Math.sqrt(src.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / n) || 1;
  const P = src.map((p) => ({ x: (p.x - cx) / spread, y: (p.y - cy) / spread }));
  const U = (r2) => (r2 < 1e-12 ? 0 : 0.5 * r2 * Math.log(r2)); // r² log r
  const N = n + 3;
  const A = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      A[i][j] = U((P[i].x - P[j].x) ** 2 + (P[i].y - P[j].y) ** 2);
    }
    A[i][i] += 1e-4; // 살짝 부드럽게 (점이 거의 겹칠 때 안정)
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = P[i].x;
    A[i][n + 2] = A[n + 2][i] = P[i].y;
  }
  const bx = [...dst.map((d) => d.x), 0, 0, 0];
  const by = [...dst.map((d) => d.y), 0, 0, 0];
  const [wx, wy] = solve(A, [bx, by]);
  return (x, y) => {
    const px = (x - cx) / spread;
    const py = (y - cy) / spread;
    let ox = wx[n] + wx[n + 1] * px + wx[n + 2] * py;
    let oy = wy[n] + wy[n + 1] * px + wy[n + 2] * py;
    for (let i = 0; i < n; i++) {
      const u = U((px - P[i].x) ** 2 + (py - P[i].y) ** 2);
      ox += wx[i] * u;
      oy += wy[i] * u;
    }
    return { x: ox, y: oy };
  };
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** 다각형 안쪽이면 +, 바깥이면 - 인 거리 */
function signedDistance(p, poly) {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return inside ? best : -best;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 사진에서 피부색 뽑기: 양 볼과 이마 주변 평균 */
function sampleSkin(canvas, lm) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let r = 0, gr = 0, b = 0, n = 0;
  const size = Math.max(3, Math.round(canvas.width / 80));
  for (const i of [50, 280, 151, 205, 425]) {
    const x = Math.round(lm[i].x - size / 2);
    const y = Math.round(lm[i].y - size / 2);
    const d = g.getImageData(Math.max(0, x), Math.max(0, y), size, size).data;
    for (let k = 0; k < d.length; k += 4) { r += d[k]; gr += d[k + 1]; b += d[k + 2]; n++; }
  }
  return new THREE.Color().setRGB(r / n / 255, gr / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

/* ------------------------- 3D 얼굴 쪽 기준점 ------------------------- */

function localPoints(mesh, toLocal, withNormals) {
  const pos = mesh.geometry.attributes.position;
  const nor = mesh.geometry.attributes.normal;
  const m = new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    const p = { x: v.x, y: v.y, z: v.z, nz: 1 };
    if (withNormals && nor) {
      v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      p.nz = v.z;
    }
    out.push(p);
  }
  return out;
}

function center(points) {
  const b = new THREE.Box3();
  for (const p of points) b.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
  return b.getCenter(new THREE.Vector3());
}

/* ------------------------- 더미 얼굴 측정 -------------------------
   표정·고개 움직임·홍조를 잠깐 끄고 더미를 정면으로 렌더링해서 얼굴 점을 찾는다.
   같은 카메라로 3D 꼭짓점을 화면 좌표로 투영해 두면, 화면 좌표 → 사진 좌표 변환 하나로 uv 가 나온다.
   parts: { renderer, scene, camera, pivot, head, eyes, hide:[Object3D] } */

export async function measureDummy(parts) {
  const { renderer, scene, camera, pivot, head, eyes, hide = [] } = parts;
  const landmarker = await preloadLandmarker();

  const savedRot = pivot.rotation.clone();
  const savedPos = pivot.position.clone();
  const savedInf = head.morphTargetInfluences.slice();
  const savedVis = hide.map((o) => o.visible);

  pivot.rotation.set(0, 0, 0);
  pivot.position.set(0, 0, 0);
  head.morphTargetInfluences.fill(0);
  hide.forEach((o) => { o.visible = false; });
  scene.updateMatrixWorld(true);

  const src = renderer.domElement;
  const W = src.width;
  const H = src.height;
  const shot = document.createElement('canvas');
  shot.width = W;
  shot.height = H;
  const g = shot.getContext('2d');
  renderer.render(scene, camera);
  g.fillStyle = '#2a2d33';
  g.fillRect(0, 0, W, H);
  g.drawImage(src, 0, 0); // 같은 작업 안에서 바로 복사해야 화면 버퍼가 남아 있다

  const toScreen = (mesh) => {
    const pos = mesh.geometry.attributes.position;
    const v = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(camera);
      out.push({ x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H });
    }
    return out;
  };
  const headPx = toScreen(head);
  const eyesPx = eyes.map(toScreen);

  pivot.rotation.copy(savedRot);
  pivot.position.copy(savedPos);
  savedInf.forEach((v, i) => { head.morphTargetInfluences[i] = v; });
  hide.forEach((o, i) => { o.visible = savedVis[i]; });

  const res = landmarker.detect(shot);
  const pts = res.faceLandmarks && res.faceLandmarks[0];
  if (!pts) return null;
  return {
    lm: pts.map((p) => ({ x: p.x * W, y: p.y * H })),
    headPx,
    eyesPx
  };
}

/* ------------------------- 사진 입히기 ------------------------- */

function photoMaterial(texture, skinColor) {
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85 });
  const skin = { value: skinColor };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.skinColor = skin;
    shader.vertexShader = 'attribute float faceWeight;\nvarying float vFaceWeight;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFaceWeight = faceWeight;');
    shader.fragmentShader = 'uniform vec3 skinColor;\nvarying float vFaceWeight;\n' +
      shader.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\n  diffuseColor.rgb = mix(skinColor, diffuseColor.rgb, vFaceWeight);');
  };
  mat.customProgramCacheKey = () => 'photo-face';
  return mat;
}

/**
 * parts: { pivot, head, eyes:[mesh], teeth:[mesh] }  (face.js 가 넘겨준다)
 * 반환: 원래대로 되돌리는 함수
 */
export function applyPhoto(parts, canvas, lm, dummy) {
  const { pivot, head, eyes } = parts;
  pivot.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(pivot.matrixWorld).invert();

  // 3D 얼굴 기준점 (표정이 없는 기본 모양 기준)
  const headPts = localPoints(head, toLocal, true);
  const eyeCenters = eyes.map((e) => center(localPoints(e, toLocal, false))).sort((a, b) => a.x - b.x);
  const teethCenter = parts.teeth.length
    ? center(parts.teeth.flatMap((t) => localPoints(t, toLocal, false)))
    : null;

  const box = center(headPts);
  const width = Math.max(...headPts.map((p) => p.x)) - Math.min(...headPts.map((p) => p.x));
  const nose = headPts.filter((p) => Math.abs(p.x - box.x) < width * 0.1).reduce((a, b) => (b.z > a.z ? b : a));
  const front = headPts.filter((p) => Math.abs(p.x - box.x) < width * 0.06 && p.z > nose.z - width * 0.35 && p.nz > 0);
  const chin = front.reduce((a, b) => (b.y < a.y ? b : a));
  const mouth = teethCenter
    ? { x: box.x, y: teethCenter.y }
    : { x: box.x, y: nose.y + (chin.y - nose.y) * 0.45 };

  // 사진 기준점 (화면 왼쪽 눈이 먼저 오게 정렬)
  const photoEyes = [avg(lm[33], lm[133]), avg(lm[362], lm[263])].sort((a, b) => a.x - b.x);
  const src = [eyeCenters[0], eyeCenters[1], nose, mouth, chin];
  const dst = [photoEyes[0], photoEyes[1], lm[1], avg(lm[13], lm[14]), lm[152]];
  const affine = fitAffine(src, dst);

  // 더미 측정이 있으면 약 100점을 정확히 맞추는 TPS, 없으면 5점 affine
  let headMap = (p) => affine(p.x, p.y);
  let eyeMap = headMap;
  if (dummy) {
    const warp = fitTPS(CONTROL.map((i) => dummy.lm[i]), CONTROL.map((i) => lm[i]));
    headMap = (p, i) => { const q = dummy.headPx[i]; return warp(q.x, q.y); };
    eyeMap = (p, i, e) => { const q = dummy.eyesPx[e][i]; return warp(q.x, q.y); };
  }

  const oval = OVAL.map((i) => lm[i]);
  const faceWidth = Math.hypot(lm[454].x - lm[234].x, lm[454].y - lm[234].y);
  const fade = faceWidth * 0.08;

  const W = canvas.width;
  const H = canvas.height;

  function build(mesh, points, useNormals, map) {
    const uv = new Float32Array(points.length * 2);
    const weight = new Float32Array(points.length);
    points.forEach((p, i) => {
      const q = map(p, i);
      uv[i * 2] = q.x / W;
      uv[i * 2 + 1] = 1 - q.y / H;
      let w = smoothstep(-fade * 0.3, fade, signedDistance(q, oval));
      if (useNormals) w *= smoothstep(0.15, 0.5, p.nz);
      weight[i] = w;
    });
    const g = mesh.geometry;
    const saved = { uv: g.attributes.uv, material: mesh.material };
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('faceWeight', new THREE.BufferAttribute(weight, 1));
    return () => {
      if (saved.uv) g.setAttribute('uv', saved.uv); else g.deleteAttribute('uv');
      g.deleteAttribute('faceWeight');
      mesh.material = saved.material;
    };
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mat = photoMaterial(texture, sampleSkin(canvas, lm));

  const undo = [build(head, headPts, true, headMap)];
  eyes.forEach((e, k) => {
    undo.push(build(e, localPoints(e, toLocal, false), false, (p, i) => eyeMap(p, i, k)));
  });
  head.material = mat;
  for (const e of eyes) e.material = mat;

  return () => {
    undo.forEach((fn) => fn());
    texture.dispose();
    mat.dispose();
  };
}
