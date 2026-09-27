/* ===================================================================
   photo.js  -  사진 속 얼굴을 3D 더미 얼굴에 입힌다

   1) MediaPipe Face Landmarker 로 사진에서 얼굴 점 478개를 찾는다 (브라우저 안에서만, 서버 전송 없음)
   2) 사진의 눈·코·입·턱 5점과 3D 얼굴의 같은 5점을 맞추는 변환(affine)을 구한다
   3) 3D 얼굴의 각 꼭짓점을 정면에서 사진 위로 투영해 텍스처 좌표(uv)로 쓴다
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
export function applyPhoto(parts, canvas, lm) {
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
  const project = fitAffine(src, dst);

  const oval = OVAL.map((i) => lm[i]);
  const faceWidth = Math.hypot(lm[454].x - lm[234].x, lm[454].y - lm[234].y);
  const fade = faceWidth * 0.08;

  const W = canvas.width;
  const H = canvas.height;

  function build(mesh, points, useNormals) {
    const uv = new Float32Array(points.length * 2);
    const weight = new Float32Array(points.length);
    points.forEach((p, i) => {
      const q = project(p.x, p.y);
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

  const undo = [build(head, headPts, true)];
  for (const e of eyes) undo.push(build(e, localPoints(e, toLocal, false), false));
  head.material = mat;
  for (const e of eyes) e.material = mat;

  return () => {
    undo.forEach((fn) => fn());
    texture.dispose();
    mat.dispose();
  };
}
