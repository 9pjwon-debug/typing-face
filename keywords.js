/* ===================================================================
   keywords.js  -  서버(AI) 없이 브라우저에서 바로 하는 감정 판단

   AI 응답이 오기 전 첫 반응, AI 가 꺼져 있거나 무료 한도에 걸렸을 때 쓰인다.

   - 감정마다 여러 묶음(group)이 있고, 묶음마다 라벨과 세기(w)가 있다.
     가장 세게 걸린 묶음의 라벨이 화면에 뜬다 (예: 슬픔 대신 "서운함").
   - 단어는 어간 위주로 적는다 ('슬프' 는 슬프다·슬프네·슬프고 모두 잡는다).
   - 정규식도 쓸 수 있다 (조사 '와' 와 감탄사 '와!' 를 구분할 때 등).
   - 부정: "안 좋아", "좋지 않아", "행복하지 않아" → 기쁨이 아니라 슬픔으로 뒤집는다.
   - 강조: "너무", "진짜", "완전" 등이 있으면 세기를 올린다. ㅋ·ㅠ·! 는 개수만큼 세진다.
   =================================================================== */

export const EMOTIONS = ['joy', 'sad', 'angry', 'surprise', 'fear', 'disgust', 'shy'];

export const LABELS = {
  joy: '기쁨', sad: '슬픔', angry: '화남', surprise: '놀람',
  fear: '두려움', disgust: '역겨움', shy: '설렘', neutral: '무표정'
};

const DICT = {
  joy: [
    { label: '기쁨', w: 0.8, words: ['기뻐', '기쁘', '기쁜', '신나', '신난', '신났', '즐거', '즐겁', '행복', '좋아', '좋다', '좋네', '좋은', '좋았', '좋겠', '좋지', '다행', '뿌듯', '흐뭇', '만족', '설렌다고'] },
    { label: '신남', w: 1, words: ['최고', '짱', '대박좋', '개좋', '존좋', '굿굿', '앗싸', '아싸', '예스', '만세', '야호', '와우', '개꿀', '꿀잼', '개웃', '웃겨', '웃기', '재밌', '재미있', '웃음', '히히', '헤헤', '하하', '호호', '킥킥', 'lol', 'lmao', 'yay', 'happy', 'great', 'awesome', 'nice'] },
    { label: '고마움', w: 0.8, words: ['고마', '고맙', '감사', '땡큐', '쌩큐', 'thank', 'thx'] },
    { label: '축하', w: 0.9, words: ['축하', '합격', '성공', '이겼', '승리', '해냈', '붙었', '당첨', '생일'] },
    { label: '사랑', w: 0.9, words: ['사랑', '예쁘', '이쁘', '멋있', '멋지', '멋져', '잘생', '훌륭', '최애', 'love'] },
    { label: '만족', w: 0.6, words: ['맛있', '맛나', '존맛', 'jmt', '편하', '편해', '시원하', '따뜻하', '포근', '힐링', '괜찮네'] },
    { label: '기쁨', w: 0.9, words: ['😊', '😄', '😁', '😆', '😂', '🤣', '😃', '😀', '🙂', '😍', '❤', '💕', '💖', '👍', '🎉', '✨', '^^', '^_^', ':)', ':D'] }
  ],
  sad: [
    { label: '슬픔', w: 0.9, words: ['슬퍼', '슬프', '슬픈', '눈물', '울었', '울고', '울어', '울것', '울 것', '엉엉', '흑흑', '훌쩍', '😢', '😭', '😿', '💔', 'sad', 'cry'] },
    { label: '우울', w: 0.8, words: ['우울', '공허', '허무', '허전', '무기력', '의욕이 없', '살기 싫', '죽고싶', '죽고 싶', '지친다', '지쳤', '지쳐', 'depress'] },
    { label: '힘듦', w: 0.7, words: ['힘들', '힘드', '힘든', '괴로', '괴롭', '버거', '벅차', '고달', '피곤', '녹초', '아파', '아프', '아픈', '다쳤'] },
    { label: '외로움', w: 0.8, words: ['외로', '외롭', '쓸쓸', '혼자야', '혼자라', '아무도 없', 'lonely'] },
    { label: '서운함', w: 0.8, words: ['서운', '섭섭', '속상', '실망', '아쉽', '아쉬', '야속', '너무해', '어떻게 그럴'] },
    { label: '그리움', w: 0.8, words: ['보고싶', '보고 싶', '그리워', '그립', '생각나', 'miss'] },
    { label: '미안함', w: 0.7, words: ['미안', '죄송', '잘못했', '내 탓', '후회', 'sorry'] },
    { label: '좌절', w: 0.8, words: ['망했', '망함', '떨어졌', '불합격', '탈락', '졌어', '졌다', '헤어졌', '차였', '포기', '끝났', '어쩔 수 없'] },
    { label: '슬픔', w: 0.5, words: ['ㅠ', 'ㅜ', 'T_T', 'T.T', ';;', '...', '하아', '하...', '에휴', '휴우', '흑'] }
  ],
  angry: [
    { label: '화남', w: 1, words: ['화나', '화났', '화가', '화내', '열받', '열 받', '빡치', '빡쳐', '빡친', '빡침', '분노', '분하', '억울', '어이없', '어이가 없', '😡', '😠', '🤬', '💢', 'angry', 'mad', 'wtf'] },
    { label: '짜증', w: 0.9, words: ['짜증', '짱나', '짜증나', '귀찮', '성가', '답답', '미치겠', '돌겠', '환장', '거슬', 'ㅡㅡ', '-_-', '--;', '하...진짜'] },
    { label: '미움', w: 0.9, words: ['싫어', '싫다', '싫은', '싫었', '미워', '밉다', '미운', '증오', '혐오', 'hate'] },
    { label: '분노', w: 1, words: ['꺼져', '닥쳐', '죽을래', '죽여', '가만 안', '가만안', '뭐하는', '장난해', '장난하', '최악', '개같', '시발', '씨발', 'ㅅㅂ', '씨바', '젠장', '제길', '빌어먹', '아오', '으악 진짜'] }
  ],
  surprise: [
    { label: '놀람', w: 1, words: ['헐', '헉', '허걱', '깜짝', '놀랐', '놀라', '놀랬', '어머', '엄마야', '세상에', '맙소사', '말도 안', '말도안', '실화', '레알?', '진짜?', '정말?', '진심?', '뭐라고', '뭐?', '뭐??', '에?', '엥', '응?', '어?', '😮', '😲', '😯', '😳', '🤯', 'omg', 'wow', 'what?'] },
    { label: '감탄', w: 0.9, words: ['대박', '미쳤', '미친', '쩐다', '쩔어', '쩌네', '오오', '우와', '와우', '우와아', '신기', '놀라워', '엄청나'] },
    { label: '감탄', w: 0.8, words: [/(^|[\s.!?])와+[!~?.\s]|^와+$/, /(^|[\s.!?])오+[!~]/] },
    { label: '놀람', w: 0.6, words: ['?!', '!?', '??'] }
  ],
  fear: [
    { label: '두려움', w: 1, words: ['무서', '무섭', '무서운', '겁나', '겁이', '겁먹', '두려', '공포', '소름', '오싹', '섬뜩', '살려', '도와줘', '😱', '😨', '😰', '😧', 'scared', 'afraid'] },
    { label: '걱정', w: 0.8, words: ['걱정', '불안', '초조', '긴장', '떨려', '떨린', '조마조마', '어떡해', '어떡하', '어쩌지', '어떻게 해', '큰일', '큰일났', '망하면', '어쩌면 좋', 'worried', 'nervous'] }
  ],
  disgust: [
    { label: '역겨움', w: 1, words: ['역겨', '역겹', '토나', '토할', '구역질', '우웩', '웩', '우욱', '토쏠', '🤢', '🤮', 'gross', 'eww'] },
    { label: '불쾌', w: 0.8, words: ['더러', '더럽', '징그', '징그러', '극혐', '혐오스', '찝찝', '끔찍', '비위', '냄새나', '냄새 나', '구려', '구리다', '별로다', '노잼', '재미없'] }
  ],
  shy: [
    { label: '설렘', w: 1, words: ['설레', '설렌', '설렜', '두근', '심쿵', '콩닥', '반했', '반할', '좋아해', '좋아한다', '사랑해', '사귀', '고백', '데이트', '썸', '뽀뽀', '안아줘', '보고싶어서', '🥰', '😘', '💘', '💓'] },
    { label: '부끄러움', w: 1, words: ['부끄', '쑥스', '수줍', '민망', '창피', '낯간지', '얼굴 빨개', '얼굴이 빨개', '몰라몰라', '아잉', '히잉', '☺', '😳', '🙈', '///'] },
    { label: '설렘', w: 0.7, words: ['예쁘다고', '귀엽다고', '잘생겼다고', '귀엽', '귀여', '칭찬', '멋있다고', '좋다고 했'] }
  ]
};

// 뒤에 오면 앞 단어를 부정하는 말, 앞에 오면 부정하는 말
const NEG_AFTER = /^[가-힣]{0,3}(지|진)\s*(도|는)?\s*(않|마|못)|^\s*(않|못)/;
const NEG_BEFORE = /(안|못|안\s|못\s|별로\s?안\s?)$/;

// 부정되면 이 감정으로 뒤집는다 (없으면 그냥 무시)
const FLIP = { joy: 'sad', shy: null, sad: null, angry: null, fear: null, disgust: null, surprise: null };

const BOOST = ['너무', '넘', '진짜', '정말', '완전', '엄청', '되게', '겁나게', '존나', '졸라', '개', '핵', '레알', '매우', '아주', '짱', '극', '미친듯이', '많이', 'so ', 'very', 'really'];

function findAll(text, word) {
  const out = [];
  if (word instanceof RegExp) {
    const re = new RegExp(word.source, word.flags.includes('g') ? word.flags : word.flags + 'g');
    let m;
    while ((m = re.exec(text))) {
      out.push({ index: m.index, length: m[0].length });
      if (!m[0].length) re.lastIndex++;
    }
    return out;
  }
  let i = text.indexOf(word);
  while (i >= 0) {
    out.push({ index: i, length: word.length });
    i = text.indexOf(word, i + word.length);
  }
  return out;
}

function negated(text, hit) {
  const before = text.slice(Math.max(0, hit.index - 5), hit.index);
  const after = text.slice(hit.index + hit.length, hit.index + hit.length + 8);
  return NEG_BEFORE.test(before) || NEG_AFTER.test(after);
}

/** 한 글자 반복(ㅋㅋㅋ, ㅠㅠㅠ, !!!)을 세기로 바꾼다 */
function repeatScore(text, re, per, max) {
  const n = (text.match(re) || []).length;
  return Math.min(max, n * per);
}

export function localGuess(input) {
  const text = String(input || '').toLowerCase();
  const score = Object.fromEntries(EMOTIONS.map((e) => [e, 0]));
  const best = {}; // 감정 → { w, label }

  function add(emotion, w, label) {
    score[emotion] += w;
    if (!best[emotion] || w > best[emotion].w) best[emotion] = { w, label };
  }

  for (const emotion of EMOTIONS) {
    for (const group of DICT[emotion]) {
      for (const word of group.words) {
        for (const hit of findAll(text, word)) {
          if (negated(text, hit)) {
            const to = FLIP[emotion];
            if (to) add(to, group.w * 0.8, to === 'sad' ? '실망' : LABELS[to]);
          } else {
            add(emotion, group.w, group.label);
          }
        }
      }
    }
  }

  // ㅋㅋ / ㅎㅎ 는 웃음, ㅠㅠ / ㅜㅜ 는 울음. 개수만큼 세진다
  const laugh = repeatScore(text, /[ㅋㅎ]/g, 0.25, 1);
  if (laugh >= 0.5) add('joy', laugh, '웃음');
  const cry = repeatScore(text, /[ㅠㅜ]/g, 0.2, 1);
  if (cry >= 0.4) add('sad', cry, '슬픔');

  // 강조어와 느낌표는 이미 걸린 감정을 키운다
  let gain = 1;
  for (const b of BOOST) if (text.includes(b)) gain += 0.15;
  gain += Math.min(0.6, (text.match(/!/g) || []).length * 0.15);
  gain = Math.min(gain, 1.8);

  const mix = {};
  for (const e of EMOTIONS) mix[e] = Math.min(1, score[e] * 0.7 * gain);

  const main = EMOTIONS.reduce((a, b) => (mix[b] > (mix[a] || 0.15) ? b : a), 'neutral');
  const label = main === 'neutral' ? LABELS.neutral : (best[main] && best[main].label) || LABELS[main];
  return { main, label, mix };
}
