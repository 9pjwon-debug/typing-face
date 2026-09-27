# 표정 더미 (typing-face)

**내가 치는 글자마다 표정이 바뀌는 3D 얼굴.**
글을 입력하면 Claude 가 감정을 판단하고, 3D 얼굴이 그 감정에 맞게 표정을 바꾼다.
순수 HTML / CSS / JS 에 Vercel 서버리스 함수 하나로 동작한다. 빌드 도구도 npm 의존성도 없다.

```
입력 ─(키워드 판단으로 즉시 반응, 한글 조합이 끝나고 0.9초 멈추면)→ /api/emotion ─→ Claude
     ← {main, label, mix:{joy,sad,angry,surprise,fear,disgust,shy}}
     → 감정별 표정 프리셋을 mix 비율로 섞어 blendshape 목표값 계산
     → 매 프레임 목표값으로 부드럽게 이동 (+ 눈 깜빡임, 숨쉬기, 볼 홍조)
```

## 배포 (GitHub → Vercel)

1. [vercel.com](https://vercel.com) → **Add New → Project** → 이 레포 **Import**
2. Framework Preset **Other**, 빌드 설정은 비워둔 채 **Deploy**
3. **Settings → Environment Variables**
   - `ANTHROPIC_API_KEY` (필수, [console.anthropic.com](https://console.anthropic.com) 에서 발급)
   - `EMOTION_MODEL` (선택, 기본 `claude-haiku-4-5`)
   - `EMOTION_DAILY_LIMIT` (선택, 하루 최대 Claude 호출 수, 기본 1000. Redis 연결 시에만 적용)
4. 선택: **Storage → Redis** 생성 후 프로젝트에 Connect (캐시와 하루 상한용)
5. **Redeploy** (환경변수는 새 배포부터 적용된다)

이후로는 `main` 에 푸시할 때마다 자동으로 배포된다.

키가 없어도 페이지는 동작한다. 이 경우 브라우저 안의 **키워드 판단**(`좋아`, `ㅠㅠ`, `헐` 등)으로
표정을 정하고, 입력창 아래에 그 사실을 표시한다.

## 로컬에서 보기

```bash
python3 -m http.server 8123   # → http://localhost:8123
```

로컬 서버에는 `/api/emotion` 이 없으므로 키워드 판단으로 동작한다.
AI 판단까지 로컬에서 보려면 `vercel dev` 를 쓴다.

## 파일

```
index.html           화면 (Three.js 는 jsDelivr CDN + importmap)
face.css             레이아웃
face.js              3D 장면, 감정 → 표정 프리셋, 입력 처리(한글 조합·디바운스·요청 취소·캐시)
api/emotion.js       감정 판단 서버리스 함수. Claude Messages API 를 fetch 로 호출,
                     JSON 스키마(structured outputs)로 응답 형식을 고정
api/redis-client.js  의존성 없는 Redis 클라이언트 (REST / redis:// 모두 지원, 선택)
models/face.glb      얼굴 모델 (ARKit 52 blendshape)
```

## API 호출 줄이기 (비용)

| 어디서 | 방법 | 효과 |
|---|---|---|
| 브라우저 | 키워드 판단으로 표정을 **먼저 바로** 바꾸고, AI 는 타이핑이 **0.9초 멈췄을 때만** 부른다 | 한 문장을 쭉 치면 보통 1번 |
| 브라우저 | 한글 조합 중(`했` 을 치는 도중)에는 부르지 않는다 | |
| 브라우저 | 공백만 바뀌었거나 이미 판단한 문장이면 다시 부르지 않는다 (탭 안 캐시) | 지웠다 다시 쳐도 0번 |
| 브라우저 | 2글자 미만은 키워드 판단만 한다 | |
| 서버 | Redis 가 연결돼 있으면 **같은 문장 결과를 7일간 캐시** (모든 사용자 공유) | 자주 나오는 문장은 0번 |
| 서버 | **하루 호출 상한** `EMOTION_DAILY_LIMIT`(기본 1000). 넘으면 그날은 키워드 판단 | 요금 폭주 방지 |
| 서버 | IP 기준 분당 60회, 한 번에 최대 200자 | 악용 방지 |

대략적인 비용: `claude-haiku-4-5` 한 번 호출이 입력 약 500토큰 + 출력 약 60토큰이라
1000번에 1달러 안쪽이다. Anthropic 콘솔의 **월 사용 한도(spend limit)** 도 함께 걸어두면 가장 확실하다.

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
