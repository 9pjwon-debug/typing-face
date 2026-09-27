# 눈치 백단 더미 (typing-face)

**뭐라고 치든 표정으로 대답해요.** 내가 치는 글자마다 표정이 바뀌는 3D 얼굴.
첫 화면에서 **내 사진을 올리면 더미가 내 얼굴로** 웃고, 삐지고, 놀란다.
글을 입력하면 Google Gemini(무료 등급)가 감정을 판단하고, 3D 얼굴이 그 감정에 맞게 표정을 바꾼다.
순수 HTML / CSS / JS 에 Vercel 서버리스 함수 하나로 동작한다. 빌드 도구도 npm 의존성도 없다.

```
입력 ─(키워드 판단으로 즉시 반응, 한글 조합이 끝나고 0.6초 멈추면)→ /api/emotion ─→ Gemini
     ← {main, label, mix:{joy,sad,angry,surprise,fear,disgust,shy}}
     → 감정별 표정 프리셋을 mix 비율로 섞어 blendshape 목표값 계산
     → 매 프레임 목표값으로 부드럽게 이동 (+ 눈 깜빡임, 숨쉬기, 볼 홍조)
```

## 배포 (GitHub → Vercel)

1. [vercel.com](https://vercel.com) → **Add New → Project** → 이 레포 **Import**
2. Framework Preset **Other**, 빌드 설정은 비워둔 채 **Deploy**
3. **Settings → Environment Variables**
   - `GEMINI_API_KEY` (필수, 아래 "무료 키 받기" 참고)
   - `EMOTION_MODEL` (선택, 기본 `gemini-3.5-flash-lite`. 무료 등급이 있는 Flash / Flash-Lite 모델만 무료)
   - `EMOTION_DAILY_LIMIT` (선택, 하루 최대 Gemini 호출 수, 기본 1000. Redis 연결 시에만 적용)
4. 선택: **Storage → Redis** 생성 후 프로젝트에 Connect (캐시와 하루 상한용)
5. **Redeploy** (환경변수는 새 배포부터 적용된다)

이후로는 `main` 에 푸시할 때마다 자동으로 배포된다.

### 무료 키 받기 (Google AI Studio)

1. [aistudio.google.com](https://aistudio.google.com) 에 구글 계정으로 로그인
2. **Get API key → Create API key** → `AIza...` 로 시작하는 키 복사
3. 결제 정보를 등록하지 않은 프로젝트면 **무료 등급**으로만 동작한다 (요금이 나가지 않는다)

무료 등급의 한계:
- 분당·하루 요청 수 제한이 있다. 걸리면(429) 서버가 `limited:true` 를 돌려주고,
  페이지는 1분 동안 키워드 판단으로 버틴 뒤 다시 AI 를 시도한다.
- 무료 등급에서 보낸 내용은 Google 이 제품 개선에 쓸 수 있다. 민감한 내용을 다루는 서비스라면 유료 등급을 쓴다.
- 키는 코드나 GitHub 에 절대 넣지 말고 Vercel 환경변수에만 넣는다.

키가 없어도 페이지는 동작한다. 이 경우 브라우저 안의 **키워드 판단**(`좋아`, `ㅠㅠ`, `헐` 등)으로
표정을 정하고, 입력창 아래에 그 사실을 표시한다.

## AI 가 연결 안 될 때

브라우저로 **`https://<도메인>/api/emotion?debug=1`** 을 연다. 키가 이 배포에 들어있는지(값은 숨김),
어떤 모델을 쓰는지, 실제로 Gemini 를 한 번 불러본 결과와 **해결 방법(hint)** 을 보여준다.

| 증상 | 원인 |
|---|---|
| `keySet: false` | 환경변수 이름이 다르거나(`GEMINI_API_KEY` 정확히), 넣은 뒤 **Redeploy 를 안 함**, 또는 Production 체크 안 함 |
| `status: 400` + API key | 키 값이 잘못 복사됨 (앞뒤 공백·따옴표 포함 등) |
| `status: 404` | 모델 이름이 없음 → `EMOTION_MODEL` 을 AI Studio 에 보이는 모델 이름으로 |
| `status: 429` | 무료 한도 초과 |

## 사진 입히기

첫 화면에서 **📷 카메라로 찍기 (가이드)** 또는 **🖼️ 앨범에서 고르기**.
가이드 카메라는 얼굴 윤곽·눈·코·입 선을 화면에 겹쳐 보여줘서 정면 무표정 사진을 찍기 쉽게 한다.
오른쪽 위 📷 버튼으로 언제든 사진을 바꾸거나 뺄 수 있다.

```
사진 ─ MediaPipe Face Landmarker (브라우저 안, 서버 전송 없음) → 얼굴 점 478개
     ─ MediaPipe Hair Segmenter → 사진에서 머리카락 영역
     ─ 더미 얼굴도 정면으로 한 장 렌더링해서 같은 도구로 얼굴 점을 찾는다
     ─ 얼굴 모양 살리기: 사진 얼굴 점(눈 윤곽·눈썹·코·입술·윤곽 약 100점)을 더미 크기로 맞춘 뒤
       thin-plate spline 으로 더미 3D 얼굴을 그 비율로 변형 (눈 사이, 얼굴 폭, 입 위치 등)
       → 표정(blendshape)은 변형된 얼굴 위에서 그대로 움직인다
     ─ 변형된 꼭짓점마다 사진 위 위치를 구해 텍스처 좌표로 사용 (눈이 눈구멍에 딱 맞음)
     ─ 머리: 사진의 머리카락은 정수리·뒤통수로 이어 입히고, 빈 두피는 머리카락 평균색으로 채움
       (머리카락이 거의 없으면 민머리로 보고 피부색)
     ─ 귀·옆면은 볼·이마에서 뽑은 피부색
     (더미 측정에 실패하면 눈·코·입·턱 5점 affine 으로 대신, 변형 없음)
```

- **사진은 서버로 올라가지 않는다.** 얼굴 인식도 입히기도 모두 브라우저 안에서 한다.
- 얼굴 인식 코드는 사진을 고를 때만 불러온다 (그냥 시작하면 받지 않는다).
  모델 파일은 `models/face_landmarker.task` (3.7MB), `models/hair_segmenter.tflite` (0.8MB) (둘 다 MediaPipe, Apache-2.0),
  실행 코드는 jsDelivr 의 `@mediapipe/tasks-vision@1.0.1`.
- 잘 나오는 사진: 정면, 무표정, 밝고 얼굴이 크게 나온 사진. 웃는 사진이면 화난 표정에도 이가 보이고,
  옆얼굴이면 한쪽이 늘어나 보인다. 얼굴 윤곽·이목구비 비율은 사진을 따라가지만, 코 높이 같은
  입체(깊이)는 더미 그대로다. 긴 머리의 옆·뒷머리는 정면 사진에 없으므로 앞머리를 이어 쓴다.
- 본인 사진이나 허락받은 사진만 쓰도록 첫 화면에 안내한다.

## 로컬에서 보기

```bash
python3 -m http.server 8123   # → http://localhost:8123
```

로컬 서버에는 `/api/emotion` 이 없으므로 키워드 판단으로 동작한다.
AI 판단까지 로컬에서 보려면 `vercel dev` 를 쓴다.

## 파일

```
index.html           첫 화면 + 본 화면 (Three.js 는 jsDelivr CDN + importmap)
face.css             레이아웃
photo.js             사진 → 얼굴 점 인식(MediaPipe) → 3D 얼굴에 입히기
keywords.js          AI 없이 바로 하는 키워드 감정 판단 (사전, 부정·강조 처리)
face.js              3D 장면, 감정 → 표정 프리셋, 입력 처리(한글 조합·디바운스·요청 취소·캐시)
api/emotion.js       감정 판단 서버리스 함수. Gemini generateContent API 를 fetch 로 호출,
                     JSON 스키마(structured outputs)로 응답 형식을 고정
api/redis-client.js  의존성 없는 Redis 클라이언트 (REST / redis:// 모두 지원, 선택)
models/face.glb      얼굴 모델 (ARKit 52 blendshape)
models/face_landmarker.task  MediaPipe 얼굴 점 인식 모델
models/hair_segmenter.tflite MediaPipe 머리카락 영역 인식 모델
```

## API 호출 줄이기

| 어디서 | 방법 | 효과 |
|---|---|---|
| 브라우저 | 키워드 판단으로 표정을 **먼저 바로** 바꾸고, AI 는 타이핑이 **0.6초 멈췄을 때만** 부른다 | 한 문장을 쭉 치면 보통 1번 |
| 브라우저 | 한글 조합 중(`했` 을 치는 도중)에는 부르지 않는다 | |
| 브라우저 | 공백만 바뀌었거나 이미 판단한 문장이면 다시 부르지 않는다 (탭 안 캐시) | 지웠다 다시 쳐도 0번 |
| 브라우저 | 2글자 미만은 키워드 판단만 한다 | |
| 서버 | Redis 가 연결돼 있으면 **같은 문장 결과를 7일간 캐시** (모든 사용자 공유) | 자주 나오는 문장은 0번 |
| 서버 | **하루 호출 상한** `EMOTION_DAILY_LIMIT`(기본 1000). 넘으면 그날은 키워드 판단 | 요금 폭주 방지 |
| 서버 | IP 기준 분당 60회, 한 번에 최대 200자 | 악용 방지 |

무료 등급에서는 요금이 나가지 않는다. 대신 호출 수 제한이 있으므로, 위 방법들은
**무료 한도 안에서 더 많은 사람이 쓸 수 있게** 해 준다.

## 키워드 사전 고치기

`keywords.js` 의 `DICT` 에 단어를 넣는다. 감정마다 묶음(라벨, 세기 `w`, 단어 목록)이 있고,
가장 세게 걸린 묶음의 라벨이 화면에 뜬다 (예: 슬픔 → "서운함", "그리움").

- 단어는 어간으로 적는다: `'슬프'` 하나로 슬프다·슬프네·슬프고 를 모두 잡는다
- "안 좋아", "행복하지 않아" 처럼 부정되면 기쁨 → 실망(슬픔)으로 뒤집는다
- "너무", "진짜", "완전", 느낌표, ㅋㅋㅋ·ㅠㅠㅠ 개수만큼 세기가 올라간다
- 콘솔에서 시험: `Face.guess('별로 안 좋았어')`

## 표정 고치기

`face.js` 의 `PRESETS` 에서 감정별 blendshape 값을 바꾼다. 이름은 ARKit 기준이고
`mouthSmile` 처럼 좌우 구분 없이 쓰면 `_L`/`_R` 양쪽에 들어간다. 콘솔에서 바로 시험할 수 있다.

```js
Face.mix({ joy: 1 })             // 활짝 웃기
Face.mix({ sad: 0.6, shy: 0.4 }) // 섞기
```

## 얼굴 모델

`models/face.glb` 는 three.js 예제의 `facecap.glb`(Face Cap 제공)에서 텍스처만 뺀 것이다.
상업적으로 쓰기 전에는 모델 라이선스를 확인하거나 직접 만든 모델(Blender shape key,
ARKit 이름 규칙)로 바꾼다. blendshape 이름만 맞으면 `face.js` 는 그대로 동작한다.

### 다음 단계: 내 얼굴로 (MICA / FLAME)

[MICA](https://github.com/Zielon/MICA) 로 사진 한 장에서 FLAME 얼굴형을 만들고,
FLAME 표정 기저를 glTF morph target 으로 구워 넣으면 같은 구조로 특정 인물 얼굴을 쓸 수 있다.
단, MICA/FLAME 은 **비상업적 연구용 라이선스**다.
