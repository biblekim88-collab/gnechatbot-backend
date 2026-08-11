// 경상남도교육청 민원 챗봇 백엔드 서버
// - 카카오톡 오픈빌더 폴백 스킬 응답
// - 웹챗봇 로그 / 학습 API (모두가 공유하는 중앙 저장소)
//
// 실행 방법: (아래 README.md 참고)
//   npm install
//   ADMIN_TOKEN=원하는비밀번호 npm start

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());               // 필요하면 특정 도메인만 허용하도록 좁힐 수 있음 (README 참고)
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://gnechatbot-backend.onrender.com').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

const DATA_DIR = path.join(__dirname, 'data');
const SCENARIOS_PATH = path.join(DATA_DIR, 'scenarios.json');
const LEARNED_PATH = path.join(DATA_DIR, 'learned.json');
const MISSED_PATH = path.join(DATA_DIR, 'missed.json');
const QUERIES_PATH = path.join(DATA_DIR, 'queries.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { return fallback; }
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 1), 'utf-8');
}

let SCENARIOS = readJson(SCENARIOS_PATH, { sections: [], blocks: [] });
const BLOCKS = SCENARIOS.blocks;
const FALLBACK_IDX = BLOCKS.findIndex(b => b.title === '질문 인식 불가 안내');

// 학습된 표현 + 대표 자연어 질문을 매칭 대상에 실시간으로 합쳐서 사용
function getEffectiveUtterances() {
  const learned = readJson(LEARNED_PATH, []);
  const merged = BLOCKS.map(b => ({ ...b, utterances: [...(b.utterances || [])] }));

  merged.forEach(b => {
    const extras = EXTRA_UTTERANCES[b.title] || [];
    // 모든 블록에 안전한 기본 자연어 변형도 몇 개 추가
    const auto = b.title && b.title !== '질문 인식 불가 안내'
      ? [`${b.title} 알려줘`, `${b.title} 안내`, `${b.title} 궁금해`]
      : [];
    [...extras, ...auto].forEach(text => {
      if (text && !b.utterances.includes(text)) b.utterances.push(text);
    });
  });

  learned.forEach(e => {
    if (merged[e.blockIdx] && !merged[e.blockIdx].utterances.includes(e.text)) {
      merged[e.blockIdx].utterances.push(e.text);
    }
  });
  return merged;
}

// ---- 동의어 사전 / 대표질문 / 안전 매칭 규칙 ----
const MATCH_POLICY = Object.freeze({
  fuzzyMinimum: 0.64,
  fuzzyStrong: 0.75,
  fuzzyMargin: 0.05,
  alternativeMinimum: 0.48
});

const SYNONYMS = {
  '졸업장':'졸업증명서', '졸업증명':'졸업증명서', '생기부':'생활기록부', '학교생활기록부':'생활기록부',
  '성적표':'성적증명서', '재적':'제적증명서', '정원외':'정원외관리증명서', '퇴직증명':'퇴직증명원',
  '영문성적표':'영문증명서', '영문졸업장':'영문증명서', '영어증명서':'영문증명서',
  '전학':'전입학', '학교옮기':'전입학', '학교옮':'전입학', '전학가':'전입학', '이사':'거주지 이전 전입학',
  '고등학생':'고등학교', '고등생':'고등학교', '고딩':'고등학교', '중학생':'중학교', '중딩':'중학교', '초등학생':'초등학교',
  '배정':'재배정', '재배정계획':'재배정', '선배정계획':'선배정',
  '수능접수':'수능원서접수', '수능원서':'수능원서접수', '수능 신청':'수능원서접수',
  '꿈디딤':'꿈디딤카드', '꿈디딤포인트':'꿈디딤카드 포인트', '다자녀':'다자녀카드사업안내', '입학지원금':'다자녀카드사업안내',
  '채용':'교육공무직원 채용 안내', '공무직채용':'교육공무직원 채용 안내', '교육공무직':'교육공무직원',
  '학원등록':'학원안내', '교습소':'학원안내', '개인과외':'학원안내',
  '팩스':'팩스민원', '신문고':'국민신문고', '정보공개':'정보공개청구',
  '아이북':'아이톡톡아이북', '아이북수리':'아이톡톡아이북', '자격증재교부':'교원자격증 재교부',
  '검고':'검정고시', '검정고사':'검정고시', '검정고ㅅㅣ':'검정고시', '검정고씨':'검정고시',
  '학폭':'학교폭력', '스승찾기':'선생님찾기', '은사찾기':'선생님찾기'
};

// 대표 자연어 질문. 기존 시나리오 내용을 벗어난 답을 만들지는 않고, 질문을 올바른 블록으로 연결하는 용도입니다.
const EXTRA_UTTERANCES = Object.freeze({
  '제증명 종합 안내': ['증명서 어디서 떼요','교육청 증명서 발급하고 싶어요','증명서 발급 방법 알려줘','학교 증명서 어떻게 발급해요'],
  '졸업증명서': ['졸업증명서 어디서 발급해요','졸업장 다시 떼고 싶어요','학교 졸업증명서 뽑는 법','졸업증명서 온라인 발급'],
  '재학증명서': ['재학증명서 떼고 싶어요','재학증명서 어디서 발급해요','학교 다니는 증명서 필요해요'],
  '생활기록부': ['생기부 발급하고 싶어요','생활기록부 어디서 떼요','학교생활기록부 발급 방법','예전 생기부 발급'],
  '성적증명서': ['성적표 발급하고 싶어요','성적증명서 어디서 떼요','학교 성적증명서 발급'],
  '제적증명서': ['제적증명서 발급하려면','학교 제적증명서 어디서 떼요'],
  '정원외관리증명서': ['정원외관리증명서 어디서 발급해요','정원외 관리 증명 필요해요'],
  '경력증명서': ['교직원 경력증명서 발급','기간제 경력증명서 떼고 싶어요','학교 근무 경력증명서'],
  '퇴직증명원': ['퇴직증명원 어디서 발급해요','교직원 퇴직증명 필요해요'],
  '개명 후 제증명 발급': ['개명했는데 생활기록부 이름 바꾸고 싶어요','개명 후 졸업증명서 이름 변경','이름 바꿨는데 생기부 정정','개명하고 학교 기록 정정'],
  '제증명 구비서류': ['증명서 발급할 때 뭐 가져가요','대리인이 증명서 떼려면 서류 뭐 필요해요','제증명 방문 준비물'],
  '영문증명서': ['영문 졸업증명서 발급','영문 성적증명서 필요해요','영어로 증명서 떼고 싶어요','아포스티유 증명서'],
  '검정고시 관련 제증명': ['검정고시 합격증명서 발급','검정고시 성적증명서 발급','검정고시 합격증 어디서 떼요','검정고시 성적표 발급'],
  '검정고시개명': ['검정고시 합격 후 개명했어요','개명했는데 검정고시 합격증 이름 바꾸고 싶어요'],
  '팩스민원': ['팩스로 증명서 신청하고 싶어요','가까운 주민센터에서 팩스민원 돼요','팩스민원 어떻게 해요'],
  '정보공개청구': ['교육청 정보공개 신청하고 싶어요','정보공개 어디서 청구해요','자료 정보공개청구 방법'],
  '국민신문고': ['교육청에 민원 넣고 싶어요','온라인으로 민원 접수 어디서 해요','국민신문고 민원 신청'],
  '교원자격증 재교부': ['교원자격증 잃어버렸어요','교원자격증 다시 발급받고 싶어요','교원자격증 재발급'],
  '수능 원서접수': ['수능 원서 어디서 접수해요','수능 접수하려면 어떻게 해요','수능 원서 접수 장소','졸업생 수능 접수'],
  '수능 원서접수 기간': ['수능 접수 언제예요','수능 원서접수 기간 알려줘','수능 원서 언제까지 내요'],
  '꿈디딤카드 종합 안내': ['꿈디딤카드가 뭐예요','꿈디딤카드 지원금 알려줘','꿈디딤카드 어떻게 써요','직업계고 취업준비지원금'],
  '꿈디딤카드 재사용재발급': ['꿈디딤카드 잃어버렸어요','꿈디딤카드 재발급 받고 싶어요','카드 분실했어요 꿈디딤'],
  '꿈디딤카드 결제오류': ['꿈디딤카드 결제가 안돼요','꿈디딤카드 카드 결제 오류','꿈디딤카드 사용이 안돼요'],
  '꿈디딤카드 미지급': ['꿈디딤 포인트가 안 들어왔어요','꿈디딤카드 포인트 미지급','지원금 아직 안 들어왔어요 꿈디딤'],
  '꿈디딤카드 잔액 확인': ['꿈디딤카드 잔액 얼마 남았어요','꿈디딤 포인트 잔액 확인','꿈디딤 남은 금액'],
  '고등학교전입학': ['창원 살다가 진주로 이사했는데 고등학생 전학하고 싶어요','고등학생 아이가 이사해서 학교를 옮기고 싶어요','고등학교 전학 절차 알려줘','다른 지역으로 이사해서 고등학교 전학'],
  '고등학교전입학제출서류': ['고등학교 전학할 때 서류 뭐 필요해요','고등학교 전입학 준비서류','고등학생 전학 제출서류 알려줘'],
  '초중학교전입학': ['중학생인데 이사해서 전학가고 싶어요','초등학생 전학 절차 알려줘','중학교 전학 어떻게 해요','초등학교 이사 전학'],
  '진로변경 전입학': ['특성화고에서 일반고로 옮기고 싶어요','일반고에서 특성화고 전학 가능한가요','진로변경 전입학 어떻게 해요'],
  '고등학교 귀국자 편입학': ['외국에서 살다 와서 고등학교 들어가려면','해외 학교 다니다 귀국했는데 고등학교 편입','귀국학생 고등학교 편입학'],
  '입학 전 선배정': ['고등학교 입학 전에 선배정 받고 싶어요','이사 예정인데 고등학교 선배정 가능해요','평준화지역 선배정'],
  '타 학군 재배정': ['고등학교 배정받고 다른 지역으로 이사했어요','타 학군으로 이사해서 재배정 받고 싶어요','입학 전 이사 재배정'],
  '검정고시 종합 안내': ['검정고시 어떻게 봐요','검정고시 처음인데 알려줘','검정고시 전체 안내','검고 정보 알려줘'],
  '2026년 제2회 검정고시': ['검정고시 접수 언제예요','검정고시 원서 어디서 접수해요','이번 검정고시 시험 일정','2026년 검정고시 접수'],
  '검정고시 자주 묻는 질문': ['검정고시 대리접수 가능한가요','검정고시 시험장 몇 시까지 가요','검정고시 시험 볼 때 자주 묻는 질문','검정고시 유의사항'],
  '검정고시 제출서류': ['검정고시 접수할 때 서류 뭐 필요해요','검정고시 준비물 서류','검정고시 원서접수 제출서류'],
  '검정고시 담당자': ['검정고시 담당자 전화번호','검정고시 문의 전화 어디예요','검고 담당자 연결'],
  '고등학교 전학 담당자': ['고등학교 전학 담당자 전화번호','고등학교 전입학 어디에 전화해요','전학 문의 담당자'],
  '창원 중학교 전입학 담당자': ['창원 중학교 전학 담당자 번호','창원에서 중학교 전학 문의 어디로 해요'],
  '창원 중학교 신입생 배정 담당자': ['창원 중학교 배정 담당자 전화번호','창원 중학교 신입생 배정 문의'],
  '교육급여': ['교육급여 신청하고 싶어요','교육급여 어떻게 신청해요','학생 교육급여 문의'],
  '다자녀카드사업안내': ['다자녀 입학지원금 어떻게 받아요','다자녀카드 지원금 알려줘','다자녀 학생 교육비 지원','다자녀 입학준비물품 구입비'],
  '다자녀카드사용처안내': ['다자녀카드 어디서 쓸 수 있어요','다자녀 포인트 사용처','다자녀카드 가맹점 알려줘'],
  '학교폭력 불복절차': ['학교폭력 결과에 이의가 있어요','학폭 처분 불복하려면','학교폭력 행정심판 어떻게 해요'],
  '교육공무직원 채용 안내': ['교육공무직 채용시험 알려줘','학교 공무직 채용 어디서 봐요','교육공무직원 채용 공고'],
  '구인구직포털': ['학교 채용공고 어디서 봐요','교육청 구인구직','기간제 채용 공고 찾고 싶어요'],
  '시험정보': ['교육청 시험 공고 어디서 봐요','임용시험 정보 알려줘','채용시험 일정'],
  '학원안내': ['학원 등록하려면 어떻게 해요','교습소 신고하려면','개인과외 신고 어디서 해요','학원 관련 문의'],
  '평생교육시설': ['평생교육시설 현황 알려줘','경남 평생교육시설 어디 있어요'],
  '스승찾기': ['예전 선생님 찾고 싶어요','은사님 연락처 찾을 수 있나요','스승찾기 신청'],
  '아이톡톡아이북': ['아이북 고장났어요','아이북 수리 어디서 해요','아이북 AS 받고 싶어요','학생 아이북 문의'],
  '경남교육청 위치': ['경남교육청 어디 있어요','교육청 주소 알려줘','경상남도교육청 가는 길'],
  '청사 배치': ['교육청 부서 위치 알려줘','교육청 사무실 어디 있어요','청사 배치도'],
  '학교찾기': ['학교 주소 찾고 싶어요','경남 학교 검색','유치원 어디 있는지 찾고 싶어요'],
  '학교시설 예약': ['학교 운동장 빌리고 싶어요','학교 강당 대여 가능한가요','학교시설 예약 방법'],
  '학교시설 사용료': ['학교시설 빌리면 얼마예요','학교 강당 사용료','학교시설 대관 비용'],
  '교육지원청 안내': ['지역 교육지원청 연락처','교육지원청 어디로 문의해요','경남 교육지원청 안내'],
  '학사일정': ['학교 개학 언제예요','입학식 날짜 궁금해요','졸업식 일정'],
  '교권 심리상담': ['교사 심리상담 받고 싶어요','교권 침해로 상담 필요해요','선생님 심리 지원'],
  '유아학비': ['유치원 유아학비 지원','유아학비 얼마나 지원돼요','유아학비 대상'],
  '유아학비 신청 및 지급방법': ['유아학비 어디서 신청해요','유아학비 지급 언제 돼요','유아학비 신청 방법'],
  '특수교육대상자 선정배치': ['특수교육대상자 선정 절차','특수교육 배치 변경하고 싶어요','특수교육대상자 배치 문의'],
  '사립유치원 무상교육': ['사립유치원 무상교육 지원','사립유치원 학비 무료인가요'],
  '교육환경보호구역': ['교육환경보호구역 확인하고 싶어요','학교 주변 보호구역 조회'],
  '학교안전공제회': ['학교에서 다쳤는데 보상받을 수 있나요','학교안전사고 공제','학교안전공제회 문의']
});

function compactText(s) {
  return (s || '').toLowerCase().replace(/[\s·ㆍ,./#!$%^&*;:{}=\-_`~()'"?<>[\]…~～]/g, '');
}

function expandQuery(q) {
  q = (q || '').toLowerCase();
  let extra = '';
  Object.keys(SYNONYMS).forEach(k => { if (q.includes(k)) extra += ' ' + SYNONYMS[k]; });
  return `${q} ${extra}`.trim();
}

// ---- 한글 자모 분해 (오타 대응) ----
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
function decomposeHangul(s) {
  let out = '';
  for (const ch of (s || '')) {
    const code = ch.codePointAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const si = code - 0xAC00;
      out += CHO[Math.floor(si/588)] + JUNG[Math.floor((si%588)/28)] + JONG[si%28];
    } else out += ch;
  }
  return out;
}
function bigrams(s) {
  s = (s || '').replace(/\s+/g,'');
  const m = new Map();
  for (let i=0;i<s.length-1;i++){ const g=s.substr(i,2); m.set(g,(m.get(g)||0)+1); }
  return m;
}
function dice(a,b) {
  const da = decomposeHangul((a || '').replace(/\s+/g,''));
  const db = decomposeHangul((b || '').replace(/\s+/g,''));
  const A = bigrams(da), B = bigrams(db);
  if (A.size===0 || B.size===0) return da===db ? 1 : 0;
  let overlap=0, totalA=0, totalB=0;
  A.forEach(v=>totalA+=v); B.forEach(v=>totalB+=v);
  A.forEach((v,k)=>{ if (B.has(k)) overlap += Math.min(v,B.get(k)); });
  return (2*overlap)/(totalA+totalB);
}
function containScore(q,u) {
  q=(q||'').replace(/\s+/g,''); u=(u||'').replace(/\s+/g,'');
  if (!q||!u) return 0;
  const shorter = q.length <= u.length ? q : u;
  const longer = q.length <= u.length ? u : q;
  if (shorter.length < 3) return 0;
  if (longer.includes(shorter)) return 0.55 + 0.25*(shorter.length/longer.length);
  return 0;
}
function scoreAgainst(query, target) {
  return Math.max(dice(query,target), containScore(query,target));
}

const EXACT_QUERY_ROUTES = Object.freeze({
  '제증명':'제증명 종합 안내','제증명안내':'제증명 종합 안내','제증명발급':'제증명 종합 안내','증명서':'제증명 종합 안내','증명서발급':'제증명 종합 안내',
  '검정고시':'검정고시 종합 안내','검정고시안내':'검정고시 종합 안내','검고':'검정고시 종합 안내','검정고사':'검정고시 종합 안내',
  '꿈디딤':'꿈디딤카드 종합 안내','꿈디딤카드':'꿈디딤카드 종합 안내','다자녀':'다자녀카드사업안내','다자녀지원':'다자녀카드사업안내',
  '수능':'수능 원서접수','수능접수':'수능 원서접수','학원':'학원안내','학원교습소':'학원안내','교습소':'학원안내',
  '정보공개':'정보공개청구','팩스':'팩스민원','팩스민원':'팩스민원','스승찾기':'스승찾기','아이북':'아이톡톡아이북','학폭':'학교폭력 불복절차'
});

function titleIndexMap(blocks) {
  const map = new Map();
  blocks.forEach((b,i) => map.set((b.title || '').trim(), i));
  return map;
}

function routeByTitle(title, blocks, reason='rule') {
  const idx = titleIndexMap(blocks).get(title);
  return idx == null ? null : { matched:true, idx, score:1, reason, candidates:[{idx,score:1}] };
}

function intentRoute(rawQuery, blocks) {
  const q = compactText(expandQuery(rawQuery));
  const has = (...xs) => xs.some(x => q.includes(compactText(x)));
  const all = (...xs) => xs.every(x => q.includes(compactText(x)));

  // 검정고시: 세부 목적을 먼저 판별하고, 단순 '검정고시'는 종합안내
  if (has('검정고시')) {
    if (has('담당자','전화번호','연락처','전화')) return routeByTitle('검정고시 담당자', blocks, 'intent');
    if (has('개명','이름변경','이름정정')) return routeByTitle('검정고시개명', blocks, 'intent');
    if (has('합격증명','성적증명','합격증','성적표','제증명')) return routeByTitle('검정고시 관련 제증명', blocks, 'intent');
    if (has('제출서류','준비서류','서류뭐','구비서류','준비물')) return routeByTitle('검정고시 제출서류', blocks, 'intent');
    if (has('대리접수','입실','유의사항','자주묻','질문')) return routeByTitle('검정고시 자주 묻는 질문', blocks, 'intent');
    if (has('접수','원서','시험일','시험장','시험일정','수험표','이번시험','2026년')) return routeByTitle('2026년 제2회 검정고시', blocks, 'intent');
    if (q.length <= 18 || has('안내','알려','어떻게봐','처음')) return routeByTitle('검정고시 종합 안내', blocks, 'intent');
  }

  // 전입학: 학교급/특수유형/서류/담당자를 분리
  const transfer = has('전입학','전학','학교옮','거주지이전');
  if (transfer) {
    if (has('귀국','해외','외국')) return routeByTitle('고등학교 귀국자 편입학', blocks, 'intent');
    if (has('진로변경','특성화고','일반고에서특성화','특성화고에서일반')) return routeByTitle('진로변경 전입학', blocks, 'intent');
    if (has('창원') && has('중학교') && has('담당자','전화','번호','연락처')) return routeByTitle('창원 중학교 전입학 담당자', blocks, 'intent');
    if (has('고등학교') && has('담당자','전화','번호','연락처')) return routeByTitle('고등학교 전학 담당자', blocks, 'intent');
    if (has('고등학교') && has('서류','제출서류','준비물','구비서류')) return routeByTitle('고등학교전입학제출서류', blocks, 'intent');
    if (has('초등학교','중학교')) return routeByTitle('초중학교전입학', blocks, 'intent');
    if (has('고등학교')) return routeByTitle('고등학교전입학', blocks, 'intent');
  }

  // 고입 선배정/재배정
  if (has('선배정')) return routeByTitle('입학 전 선배정', blocks, 'intent');
  if (has('재배정') && has('이사','타학군','학군')) return routeByTitle('타 학군 재배정', blocks, 'intent');

  // 꿈디딤
  if (has('꿈디딤')) {
    if (has('분실','잃어버','재발급','재사용')) return routeByTitle('꿈디딤카드 재사용재발급', blocks, 'intent');
    if (has('결제오류','결제안','사용안','결제가안')) return routeByTitle('꿈디딤카드 결제오류', blocks, 'intent');
    if (has('미지급','안들어','지급안','포인트안')) return routeByTitle('꿈디딤카드 미지급', blocks, 'intent');
    if (has('잔액','남은금액','얼마남')) return routeByTitle('꿈디딤카드 잔액 확인', blocks, 'intent');
    return routeByTitle('꿈디딤카드 종합 안내', blocks, 'intent');
  }

  // 다자녀
  if (has('다자녀','입학지원금')) {
    if (has('사용처','가맹점','어디서써','쓸수')) return routeByTitle('다자녀카드사용처안내', blocks, 'intent');
    return routeByTitle('다자녀카드사업안내', blocks, 'intent');
  }

  // 수능
  if (has('수능')) {
    if (has('기간','언제','마감','접수일')) return routeByTitle('수능 원서접수 기간', blocks, 'intent');
    return routeByTitle('수능 원서접수', blocks, 'intent');
  }

  // 제증명 세부
  if (has('생기부','생활기록부')) {
    if (has('개명','이름바','정정')) return routeByTitle('개명 후 제증명 발급', blocks, 'intent');
    return routeByTitle('생활기록부', blocks, 'intent');
  }
  if (has('졸업증명서','졸업장')) return routeByTitle('졸업증명서', blocks, 'intent');
  if (has('재학증명서')) return routeByTitle('재학증명서', blocks, 'intent');
  if (has('성적증명서','성적표')) return routeByTitle('성적증명서', blocks, 'intent');
  if (has('제적증명서')) return routeByTitle('제적증명서', blocks, 'intent');
  if (has('정원외관리')) return routeByTitle('정원외관리증명서', blocks, 'intent');
  if (has('경력증명서')) return routeByTitle('경력증명서', blocks, 'intent');
  if (has('퇴직증명')) return routeByTitle('퇴직증명원', blocks, 'intent');
  if (has('영문증명','영문졸업','영문성적','아포스티유')) return routeByTitle('영문증명서', blocks, 'intent');
  if (has('제증명','증명서발급') && has('구비서류','준비물','뭐가져')) return routeByTitle('제증명 구비서류', blocks, 'intent');

  // 기타 빈도가 높은 업무
  if (has('학교폭력','학폭') && has('불복','이의','행정심판')) return routeByTitle('학교폭력 불복절차', blocks, 'intent');
  if (has('교육공무직','공무직') && has('채용','시험','공고')) return routeByTitle('교육공무직원 채용 안내', blocks, 'intent');
  if (has('아이북') && has('고장','수리','as','에이에스')) return routeByTitle('아이톡톡아이북', blocks, 'intent');
  if (has('스승','선생님','은사') && has('찾')) return routeByTitle('스승찾기', blocks, 'intent');
  if (has('학원','교습소','개인과외')) return routeByTitle('학원안내', blocks, 'intent');
  if (has('정보공개')) return routeByTitle('정보공개청구', blocks, 'intent');
  if (has('국민신문고','온라인민원','고충민원')) return routeByTitle('국민신문고', blocks, 'intent');
  if (has('팩스민원')) return routeByTitle('팩스민원', blocks, 'intent');
  if (has('교육급여')) return routeByTitle('교육급여', blocks, 'intent');

  return null;
}

function domainLockIndices(rawQuery, blocks) {
  const q = compactText(expandQuery(rawQuery));
  const titles = new Set();
  const addIf = pred => blocks.forEach((b,i) => { if (pred(b.title || '')) titles.add(i); });

  if (q.includes('검정고시')) addIf(t => t.includes('검정고시'));
  else if (/(꿈디딤)/.test(q)) addIf(t => t.includes('꿈디딤'));
  else if (/(다자녀|입학지원금)/.test(q)) addIf(t => t.includes('다자녀'));
  else if (/(수능)/.test(q)) addIf(t => t.includes('수능') || t.includes('대입정보'));
  else if (/(전입학|전학|학교옮|거주지이전)/.test(q)) addIf(t => t.includes('전입학') || t.includes('전학') || t.includes('재배정') || t.includes('선배정') || t.includes('귀국자'));
  else if (/(학원|교습소|개인과외)/.test(q)) addIf(t => t.includes('학원') || t.includes('평생교육시설'));
  else if (/(학교폭력|학폭)/.test(q)) addIf(t => t.includes('학교폭력'));

  return titles.size ? titles : null;
}

function fuzzyCandidates(rawQuery, blocks, n=5) {
  const query = expandQuery(rawQuery);
  const lock = domainLockIndices(rawQuery, blocks);
  const scored = blocks.map((b,i) => {
    if (i === FALLBACK_IDX) return {idx:i, score:0};
    if (lock && !lock.has(i)) return {idx:i, score:0};
    let s = scoreAgainst(query, b.title || '') * 0.90;
    (b.utterances || []).forEach(u => { s = Math.max(s, scoreAgainst(query, u)); });
    return {idx:i, score:s};
  }).filter(x => x.score > 0).sort((a,b)=>b.score-a.score);
  return scored.slice(0,n);
}

function smartMatch(rawQuery, blocks) {
  const raw = (rawQuery || '').trim();
  if (!raw) return {matched:false, idx:-1, score:0, reason:'empty', candidates:[]};

  const compact = compactText(raw);
  const exactTitle = EXACT_QUERY_ROUTES[compact];
  if (exactTitle) {
    const routed = routeByTitle(exactTitle, blocks, 'exact-route');
    if (routed) return routed;
  }

  // 제목/대표발화 완전일치
  for (let i=0;i<blocks.length;i++) {
    if (i === FALLBACK_IDX) continue;
    const b = blocks[i];
    if (compact === compactText(b.title)) return {matched:true, idx:i, score:1, reason:'exact-title', candidates:[{idx:i,score:1}]};
    if ((b.utterances || []).some(u => compact === compactText(u))) return {matched:true, idx:i, score:1, reason:'exact-utterance', candidates:[{idx:i,score:1}]};
  }

  const intent = intentRoute(raw, blocks);
  if (intent) return intent;

  const candidates = fuzzyCandidates(raw, blocks, 5);
  const best = candidates[0] || {idx:-1,score:0};
  const second = candidates[1] || {idx:-1,score:0};
  const margin = best.score - second.score;
  const strong = best.score >= MATCH_POLICY.fuzzyStrong;
  const safe = best.score >= MATCH_POLICY.fuzzyMinimum && (strong || margin >= MATCH_POLICY.fuzzyMargin);
  return { matched:safe, idx:best.idx, score:best.score, secondScore:second.score, margin, reason:safe?'fuzzy-safe':'ambiguous', candidates };
}

function findBestBlock(rawQuery, blocks) {
  const r = smartMatch(rawQuery, blocks);
  return { idx:r.idx, score:r.score, reason:r.reason, matched:r.matched };
}

function topCandidates(rawQuery, blocks, n) {
  const r = smartMatch(rawQuery, blocks);
  if (r.candidates && r.candidates.length) return r.candidates.slice(0,n).filter(c => c.score >= MATCH_POLICY.alternativeMinimum || r.reason === 'intent' || r.reason === 'exact-route');
  return fuzzyCandidates(rawQuery, blocks, n).filter(c => c.score >= MATCH_POLICY.alternativeMinimum);
}

// ============ 생성형 AI 폴백용 검색 / 대화 메모리 ============
// Render 환경변수에 ANTHROPIC_API_KEY, ANTHROPIC_MODEL을 설정하면 활성화됩니다.
// API 키가 없거나 호출에 실패하면 기존 폴백 응답으로 안전하게 돌아갑니다.
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const ANTHROPIC_MODEL = (process.env.ANTHROPIC_MODEL || '').trim();
const AI_ENABLED = !!(ANTHROPIC_API_KEY && ANTHROPIC_MODEL);

// 같은 카카오 이용자의 짧은 후속질문("일반고야", "2학년이야" 등)을 이어받기 위한 임시 메모리
// 서버 재시작 시 사라지며, 15분이 지나면 자동 폐기합니다.
const KAKAO_SESSIONS = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

// 카카오에서 질문을 연속으로 못 알아들은 횟수 관리
// 2회 이상 연속 실패하면 1:1 채팅상담 바로가기를 우선 노출합니다.
const KAKAO_FAIL_STREAKS = new Map();
// 전학 관련 질문의 연속 실패 횟수는 별도로 관리합니다.
// 고등학교 전학 맥락에서 2회 이상 실패하면 참고용 AI 상담 링크를 함께 노출합니다.
const KAKAO_TRANSFER_FAIL_STREAKS = new Map();
const FAIL_STREAK_TTL_MS = 30 * 60 * 1000;
const FAIL_STREAK_ESCALATE_AT = 2;
const TRANSFER_AI_ESCALATE_AT = 2;
const HIGH_SCHOOL_TRANSFER_GPT_URL = 'https://chatgpt.com/g/g-6a797a1288d08191a19ab551961d9fdd-godeunghaggyo-jeonibhag';
// 경상남도교육청 공식 전입학 페이지의 최신 담당자 정보를 실시간 조회합니다.
// 생성형 AI API와 무관하며, Node의 fetch로 공개 홈페이지를 읽습니다.
const GNE_HIGH_TRANSFER_URL = 'https://www.gne.go.kr/www/chamyeo/admission/high.jsp';
const GNE_EMSCHOOL_URL = 'https://www.gne.go.kr/www/chamyeo/admission/emschool.jsp';
const TRANSFER_CONTACT_CACHE_TTL_MS = 30 * 60 * 1000; // 30분
const TRANSFER_CONTACT_CACHE = { high: null, middle: null };

const GNE_SUPPORT_REGIONS = [
  '창원','진주','통영','사천','김해','밀양','거제','양산','의령',
  '함안','창녕','고성','남해','하동','산청','함양','거창','합천'
];

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function htmlFragmentToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/td|\/th|\/h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOfficialPhone(text) {
  return String(text || '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s*~\s*/g, '~')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstCallablePhone(text) {
  const m = String(text || '').match(/0\d{1,2}\s*-\s*\d{3,4}\s*-\s*\d{4}/);
  return m ? m[0].replace(/\s+/g, '') : '';
}

async function fetchOfficialGneHtml(url, timeoutMs = 2800) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'user-agent': 'GNE-1004-Chatbot/1.0'
      }
    });
    if (!response.ok) throw new Error(`공식 홈페이지 HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getFreshTransferContactCache(key) {
  const entry = TRANSFER_CONTACT_CACHE[key];
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TRANSFER_CONTACT_CACHE_TTL_MS) return null;
  return entry.data;
}

function saveTransferContactCache(key, data) {
  TRANSFER_CONTACT_CACHE[key] = { updatedAt: Date.now(), data };
  return data;
}

async function getHighSchoolTransferContact() {
  const cached = getFreshTransferContactCache('high');
  if (cached) return cached;

  try {
    const html = await fetchOfficialGneHtml(GNE_HIGH_TRANSFER_URL);
    const text = htmlFragmentToText(html);
    const marker = Math.max(text.lastIndexOf('담당자 정보'), text.lastIndexOf('담당자정보'));
    const tail = marker >= 0 ? text.slice(marker, marker + 700) : text.slice(-1200);

    let department = '';
    const deptPart = tail.match(/담당부서\s+(.{1,60}?)\s+전화번호/i);
    if (deptPart) department = deptPart[1].trim();

    const phoneMatch = tail.match(/0\d{1,2}\s*-\s*\d{3,4}\s*-\s*\d{4}/);
    const phone = phoneMatch ? normalizeOfficialPhone(phoneMatch[0]) : '';

    if (!department || !phone) throw new Error('고등학교 전입학 담당자 영역을 해석하지 못했습니다.');

    return saveTransferContactCache('high', {
      level: '고등학교', department, phone, url: GNE_HIGH_TRANSFER_URL
    });
  } catch (err) {
    const stale = TRANSFER_CONTACT_CACHE.high && TRANSFER_CONTACT_CACHE.high.data;
    if (stale) return { ...stale, stale: true };
    throw err;
  }
}

function parseMiddleSchoolSupportContacts(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    let cell;
    while ((cell = cellRe.exec(tr[1])) !== null) cells.push(htmlFragmentToText(cell[1]));
    if (!cells.length) continue;

    const officeIdx = cells.findIndex(c => /교육지원청/.test(c) && !/^지역교육청$/.test(c));
    const phoneIdx = cells.findIndex(c => /0\d{1,2}\s*-\s*\d{3,4}\s*-\s*\d{3,4}/.test(c));
    if (officeIdx < 0 || phoneIdx < 0) continue;

    const office = cells[officeIdx].trim();
    const region = office.replace(/교육지원청.*$/, '').trim();
    if (!GNE_SUPPORT_REGIONS.includes(region)) continue;

    rows.push({
      region,
      office,
      department: (cells[officeIdx + 1] || '').trim(),
      team: (cells[officeIdx + 2] || '').trim(),
      phone: normalizeOfficialPhone(cells[phoneIdx]),
      url: GNE_EMSCHOOL_URL
    });
  }

  const byRegion = new Map();
  rows.forEach(row => { if (!byRegion.has(row.region)) byRegion.set(row.region, row); });
  return [...byRegion.values()];
}

async function getMiddleSchoolTransferContacts() {
  const cached = getFreshTransferContactCache('middle');
  if (cached) return cached;

  try {
    const html = await fetchOfficialGneHtml(GNE_EMSCHOOL_URL);
    const contacts = parseMiddleSchoolSupportContacts(html);
    if (contacts.length < 10) throw new Error(`중학교 전입학 담당자 표 해석 결과가 부족합니다(${contacts.length}건).`);
    return saveTransferContactCache('middle', contacts);
  } catch (err) {
    const stale = TRANSFER_CONTACT_CACHE.middle && TRANSFER_CONTACT_CACHE.middle.data;
    if (stale) return stale.map(x => ({ ...x, stale: true }));
    throw err;
  }
}

function detectTransferContactIntent(rawQuery) {
  const q = compactText(expandQuery(rawQuery));
  const isTransfer = /(전입학|전학|편입학|학교옮)/.test(q);
  const isContact = /(담당자|담당부서|전화번호|연락처|문의처|전화|어디로문의|어디에문의|누구한테|누구에게)/.test(q);
  if (!isTransfer || !isContact) return null;

  let level = '';
  if (/(고등학교|고교|고딩|고등학생)/.test(q)) level = 'high';
  else if (/(중학교|중딩|중학생)/.test(q)) level = 'middle';
  else if (/(초등학교|초딩|초등학생)/.test(q)) level = 'elementary';

  const region = GNE_SUPPORT_REGIONS.find(name => q.includes(name)) || '';
  return { level, region };
}

function kakaoTransferContactLevelResponse() {
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: '전학 담당자를 확인하려면 학교급을 알려주세요.\n고등학교, 중학교, 초등학교 중에서 선택해 주세요.' } }],
      quickReplies: [
        { label: '고등학교 전학 담당자', action: 'message', messageText: '고등학교 전학 담당자' },
        { label: '중학교 전학 담당자', action: 'message', messageText: '중학교 전학 담당자' },
        { label: '초등학교 전학 안내', action: 'message', messageText: '초등학교 전학 담당자' }
      ]
    }
  };
}

function kakaoOfficialPageCard(title, description, url, phone) {
  const buttons = [];
  const callable = firstCallablePhone(phone);
  if (callable) buttons.push({ label: '☎ 담당자 전화', action: 'phone', phoneNumber: callable.replace(/-/g, '') });
  buttons.push({ label: '공식 전입학 안내', action: 'webLink', webLinkUrl: url });
  return { basicCard: { title, description: description || ' ', buttons } };
}

async function kakaoTransferContactResponse(intent) {
  try {
    if (!intent.level) return kakaoTransferContactLevelResponse();

    if (intent.level === 'high') {
      const contact = await getHighSchoolTransferContact();
      const freshness = contact.stale ? '\n※ 공식 홈페이지 실시간 조회가 지연되어 직전 조회 정보를 표시합니다.' : '';
      const text = `고등학교 전입학 담당자 정보입니다.\n담당부서: ${contact.department}\n전화번호: ${contact.phone}${freshness}`;
      return {
        version: '2.0',
        template: {
          outputs: [
            { simpleText: { text } },
            kakaoOfficialPageCard('고등학교 전입학', '경상남도교육청 공식 페이지의 담당자 정보를 불러왔어요.', contact.url, contact.phone)
          ]
        }
      };
    }

    if (intent.level === 'middle') {
      if (!intent.region) {
        return {
          version: '2.0',
          template: {
            outputs: [
              { simpleText: { text: '중학교 전학은 전입하려는 지역의 교육지원청 담당자를 확인해야 해요.\n전입하려는 경남 시·군을 입력해 주세요. (예: 진주 중학교 전학 담당자)' } },
              { basicCard: { title: '초·중학교 전입학', description: '지역교육지원청 전입학 담당자 현황은 공식 페이지에서 확인할 수 있어요.', buttons: [{ label: '공식 담당자 현황', action: 'webLink', webLinkUrl: GNE_EMSCHOOL_URL }] } }
            ]
          }
        };
      }

      const contacts = await getMiddleSchoolTransferContacts();
      const contact = contacts.find(x => x.region === intent.region);
      if (!contact) throw new Error(`${intent.region} 지역 담당자 행을 찾지 못했습니다.`);

      const freshness = contact.stale ? '\n※ 공식 홈페이지 실시간 조회가 지연되어 직전 조회 정보를 표시합니다.' : '';
      const text = `${contact.region} 중학교 전입학 담당자 정보입니다.\n${contact.office}\n담당과: ${contact.department}\n담당: ${contact.team}\n전화번호: ${contact.phone}${freshness}`;
      return {
        version: '2.0',
        template: {
          outputs: [
            { simpleText: { text } },
            kakaoOfficialPageCard(`${contact.region} 중학교 전입학`, `${contact.office} 공식 담당자 정보입니다.`, contact.url, contact.phone)
          ]
        }
      };
    }

    return {
      version: '2.0',
      template: {
        outputs: [
          { simpleText: { text: '경상남도교육청 공식 초·중학교 전입학 페이지에는 초등학교 전학 절차는 안내되어 있지만, 지역교육청 담당자 현황 표는 중학교 항목으로 게시되어 있어 초등학교 담당자로 임의 안내하지 않아요.\n정확한 담당자는 공식 페이지에서 확인해 주세요.' } },
          { basicCard: { title: '초·중학교 전입학 공식 안내', description: '경상남도교육청 공식 페이지', buttons: [{ label: '공식 페이지 확인', action: 'webLink', webLinkUrl: GNE_EMSCHOOL_URL }] } }
        ]
      }
    };
  } catch (err) {
    console.error('전입학 담당자 실시간 조회 오류:', err && err.message ? err.message : err);
    const url = intent && intent.level === 'high' ? GNE_HIGH_TRANSFER_URL : GNE_EMSCHOOL_URL;
    return {
      version: '2.0',
      template: {
        outputs: [
          { simpleText: { text: '현재 경상남도교육청 공식 홈페이지의 담당자 정보를 실시간으로 불러오지 못했어요.\n잘못된 연락처를 임의로 안내하지 않고, 공식 페이지에서 확인할 수 있도록 연결해 드릴게요.' } },
          { basicCard: { title: '전입학 공식 안내', description: '공식 홈페이지에서 최신 담당자 정보를 확인해 주세요.', buttons: [{ label: '공식 페이지 확인', action: 'webLink', webLinkUrl: url }] } }
        ]
      }
    };
  }
}


// ============ 경상남도교육청 본청 업무담당자 실시간 검색 ============
// 경남교육청이 제공하는 공식 "업무검색" 페이지의 검색 폼을 그대로 이용합니다.
// 유료 AI API를 사용하지 않으며, 담당업무/전화번호를 server.js에 고정하지 않습니다.
const GNE_HQ_WORK_SEARCH_URL = 'https://www.gne.go.kr/user/deptBsnsAsgn/BD_searchDeptBsnsAsgnList.do';
const HQ_CONTACT_FORM_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 검색 폼 구조 12시간 캐시
const HQ_CONTACT_QUERY_CACHE_TTL_MS = 30 * 60 * 1000; // 동일 업무검색 결과 30분 캐시
const HQ_CONTACT_ALL_CACHE_TTL_MS = 30 * 60 * 1000; // 본청 전체 업무분장 30분 캐시
const HQ_CONTACT_PERSIST_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 최근 성공 조회본은 최대 12시간 안전 캐시
const HQ_CONTACT_CACHE_FILE = path.join(DATA_DIR, 'hq_contacts_cache.json');
let GNE_HQ_SEARCH_FORM_CACHE = null;
let GNE_HQ_ALL_CONTACTS_CACHE = null;
let GNE_HQ_REFRESH_PROMISE = null;
const GNE_HQ_QUERY_CACHE = new Map();

function parseHtmlAttrs(tagText) {
  const attrs = {};
  const attrRe = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = attrRe.exec(String(tagText || ''))) !== null) {
    attrs[String(m[1] || '').toLowerCase()] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function normalizeHqPhone(text) {
  let value = normalizeOfficialPhone(text);
  // 본청 페이지 일부 표기는 지역번호가 생략될 수 있어 통화용 표기만 보완합니다.
  if (/^(?:210|268|278)-\d{4}$/.test(value)) value = `055-${value}`;
  return value;
}

function truncateOfficialDuty(text, maxLen = 150) {
  const clean = String(text || '').replace(/[ㆍ·◦]/g, '·').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1).trimEnd() + '…';
}

function discoverGneHqSearchFormFromHtml(html) {
  const forms = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(String(html || ''))) !== null) {
    const formAttrs = parseHtmlAttrs(fm[1]);
    const inner = fm[2];
    const inputs = [];
    const inputRe = /<input\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(inner)) !== null) {
      const a = parseHtmlAttrs(im[1]);
      if (a.name) inputs.push(a);
    }

    const searchInput = inputs.find(a => {
      const type = String(a.type || 'text').toLowerCase();
      if (!['text','search'].includes(type)) return false;
      const key = `${a.name || ''} ${a.id || ''} ${a.placeholder || ''}`.toLowerCase();
      return /(bsns|work|search|srch|keyword|query|업무|검색)/.test(key);
    }) || inputs.find(a => ['text','search'].includes(String(a.type || 'text').toLowerCase()));

    if (!searchInput) continue;

    let score = 0;
    const action = String(formAttrs.action || '');
    const plain = htmlFragmentToText(inner);
    if (/BD_searchDeptBsnsAsgnList\.do/i.test(action)) score += 100;
    if (/업무검색|찾으시려는 업무|담당업무/.test(plain)) score += 40;
    if (/(bsns|work)/i.test(searchInput.name || '')) score += 20;
    if (/(search|srch|keyword|query)/i.test(searchInput.name || '')) score += 10;

    const hidden = {};
    inputs.forEach(a => {
      if (String(a.type || '').toLowerCase() === 'hidden' && a.name) hidden[a.name] = a.value || '';
    });

    forms.push({
      score,
      method: String(formAttrs.method || 'GET').toUpperCase(),
      action: action || GNE_HQ_WORK_SEARCH_URL,
      queryField: searchInput.name,
      hidden
    });
  }

  if (!forms.length) return null;
  forms.sort((a,b) => b.score - a.score);
  const best = forms[0];
  try { best.action = new URL(best.action, GNE_HQ_WORK_SEARCH_URL).href; }
  catch (_) { best.action = GNE_HQ_WORK_SEARCH_URL; }
  return best;
}

async function fetchOfficialGneFormResult(form, query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const params = new URLSearchParams({ ...(form.hidden || {}), [form.queryField]: query });
    const method = String(form.method || 'GET').toUpperCase();
    const headers = {
      'accept': 'text/html,application/xhtml+xml',
      'user-agent': 'GNE-1004-Chatbot/1.0',
      'referer': GNE_HQ_WORK_SEARCH_URL
    };
    let url = form.action || GNE_HQ_WORK_SEARCH_URL;
    const options = { method, signal: controller.signal, headers };
    if (method === 'GET') {
      url += (url.includes('?') ? '&' : '?') + params.toString();
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      options.body = params.toString();
    }
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`공식 업무검색 HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function getGneHqSearchForm() {
  if (GNE_HQ_SEARCH_FORM_CACHE && Date.now() - GNE_HQ_SEARCH_FORM_CACHE.updatedAt < HQ_CONTACT_FORM_CACHE_TTL_MS) {
    return GNE_HQ_SEARCH_FORM_CACHE.form;
  }
  const html = await fetchOfficialGneHtml(GNE_HQ_WORK_SEARCH_URL);
  const form = discoverGneHqSearchFormFromHtml(html);
  if (!form || !form.queryField) throw new Error('경남교육청 업무검색 입력 항목을 찾지 못했습니다.');
  GNE_HQ_SEARCH_FORM_CACHE = { updatedAt: Date.now(), form };
  return form;
}

function parseGneHqWorkSearchResults(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(String(html || ''))) !== null) {
    const cells = [];
    const cellRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
    let cell;
    while ((cell = cellRe.exec(tr[1])) !== null) cells.push(htmlFragmentToText(cell[1]));
    if (cells.length < 4) continue;

    // 공식 업무검색 결과 표: 부서 | 담당명 | 직위·직급 | 전화번호 | 담당업무
    const phoneIdx = cells.findIndex(c => /(?:055\s*[-)]?\s*)?(?:210|268|278)\s*-\s*\d{4}/.test(c));
    if (phoneIdx < 0) continue;

    const department = String(cells[0] || '').trim();
    const team = String(cells[1] || '').trim();
    const position = phoneIdx >= 1 ? String(cells[phoneIdx - 1] || '').trim() : '';
    const phone = normalizeHqPhone(cells[phoneIdx]);
    const duty = cells.slice(phoneIdx + 1).join(' ').replace(/\s+/g, ' ').trim();

    if (!department || !phone || !duty) continue;
    if (/^(부서|담당명|전화번호|담당업무)$/.test(department)) continue;

    rows.push({ department, team, position, phone, duty, url: GNE_HQ_WORK_SEARCH_URL });
  }

  // 같은 전화번호 + 같은 업무가 중복 표출되는 경우 하나로 정리
  const unique = new Map();
  rows.forEach(row => {
    const key = `${row.department}|${row.phone}|${row.duty}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()];
}

function normalizeHqContactSearchQuery(rawQuery) {
  let q = String(rawQuery || '').trim().replace(/\s+/g, ' ');
  if (!q) return '';

  // 민원인이 자주 붙이는 표현 때문에 공식 업무분장 검색어가 지나치게 좁아지지 않도록
  // 의미가 명확한 경우에만 대표 검색어로 정규화합니다.
  // 예) '다자녀 지원 담당자' → '다자녀'
  const compact = compactText(q);
  if (/^다자녀(?:지원|지원금|입학지원|입학지원금|교육비지원)?$/.test(compact)) return '다자녀';

  return q;
}

// 본청 업무담당자 검색에서 민원인이 붙이는 일반적인 행동어 때문에
// 공식 업무분장 핵심어를 놓치는 경우를 보완합니다.
// 1차 검색이 실패한 경우에만 사용하므로, 원래 검색의 정확도를 해치지 않습니다.
function hqContactFallbackQueries(query) {
  const raw = String(query || '').trim().replace(/\s+/g, ' ');
  if (!raw) return [];

  const out = [];
  const add = value => {
    const v = String(value || '').trim().replace(/\s+/g, ' ');
    if (v && compactText(v) !== compactText(raw) && !out.some(x => compactText(x) === compactText(v))) out.push(v);
  };

  // 예) '제증명 발급'→'제증명', '검정고시 접수'→'검정고시',
  //     '직업교육 지원'→'직업교육', '학교폭력 신고'→'학교폭력'
  const generic = new Set([
    '지원','지원금','신청','신청방법','발급','재발급','접수','신고','처리',
    '운영','관리','상담','안내','이용','청구','문의','업무','관련'
  ]);
  const tokens = (raw.match(/[가-힣A-Za-z0-9]+/g) || []).filter(Boolean);
  const reduced = tokens.filter(t => !generic.has(t));
  if (reduced.length && reduced.length < tokens.length) add(reduced.join(' '));

  // 띄어쓰기 없이 입력한 경우도 제한적으로 보완합니다.
  // 핵심어가 3글자 이상일 때만 잘라 '교육지원'→'교육' 같은 과도한 축약을 막습니다.
  const compact = compactText(raw);
  const suffixes = ['신청방법','재발급','지원금','지원','신청','발급','접수','신고','처리','운영','관리','상담','안내','이용','청구'];
  for (const suffix of suffixes) {
    if (!compact.endsWith(suffix)) continue;
    const stem = compact.slice(0, -suffix.length);
    if (stem.length >= 3) add(stem);
  }

  return out;
}

function hqContactQueryCore(rawQuery) {
  let q = String(rawQuery || '').trim();
  q = q
    .replace(/경상남도교육청|경남교육청|교육청\s*본청|본청/gi, ' ')
    .replace(/업무\s*담당자|업무\s*담당|담당\s*공무원|담당자|담당부서|담당과|문의처|연락처|전화번호|전화\s*번호|전화|연락/gi, ' ')
    .replace(/누구(?:한테|에게)?|어디(?:로|에)?\s*(?:문의|전화)?|문의(?:하고\s*싶어|하려면|해야\s*해|해요|할까요)?/gi, ' ')
    .replace(/알려\s*줘|알려주세요|알려\s*주세요|찾아\s*줘|찾아주세요|찾아\s*주세요|연결\s*해줘|연결해주세요/gi, ' ')
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeHqContactSearchQuery(q);
}

function detectHqContactIntent(rawQuery) {
  const raw = String(rawQuery || '').trim();
  const q = compactText(expandQuery(raw));
  const isContact = /(업무담당자|담당자|담당부서|담당과|전화번호|연락처|문의처|문의|전화|누구한테|누구에게|어디로문의|어디에문의)/.test(q);
  if (!isContact) return null;

  // 교육지원청·학교·직속기관 담당자는 이번 기능 범위(본청)에서 제외합니다.
  if (/교육지원청|지원청/.test(q) && !/(경상남도교육청|경남교육청|본청)/.test(q)) return null;
  if (/(학교담당자|학교전화|학교연락처)/.test(q)) return null;

  return { query: hqContactQueryCore(raw) };
}

async function fetchGneHqSearchFast(query = '', timeoutMs = 8000) {
  // 실제 검색 입력 name이 사이트 개편으로 바뀌어도 최대한 버티도록
  // 자주 쓰이는 검색필드명을 한 번의 GET 요청에 함께 전달합니다.
  // 빈 검색어라도 query string 자체를 붙여 '검색 결과 화면'이 렌더링되도록 시도합니다.
  const candidateFields = [
    'searchKeyword','searchText','searchWord','keyword','query','searchQuery',
    'srchKeyword','srchText','srchWord','searchValue','searchBsns','srchBsns',
    'bsnsNm','bsnsCn','bsnsKeyword','searchBsnsCn'
  ];
  const params = new URLSearchParams();
  candidateFields.forEach(name => params.set(name, String(query ?? '')));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GNE_HQ_WORK_SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'referer': GNE_HQ_WORK_SEARCH_URL
      }
    });
    if (!response.ok) throw new Error(`공식 업무검색 HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getFreshHqQueryCache(query) {
  const key = compactText(query);
  const entry = GNE_HQ_QUERY_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > HQ_CONTACT_QUERY_CACHE_TTL_MS) {
    GNE_HQ_QUERY_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function saveHqQueryCache(query, data) {
  const key = compactText(query);
  GNE_HQ_QUERY_CACHE.set(key, { updatedAt: Date.now(), data });
  return data;
}

function hqSearchTokens(query) {
  return (String(query || '').match(/[가-힣A-Za-z0-9]+/g) || [])
    .map(x => x.trim())
    .filter(x => x.length >= 2 && !/^(관련|업무|문의|담당|안내|정보)$/.test(x));
}

// 민원인에게 직접 연결할 실무 담당자 검색이 목적이므로
// 기관장/간부/관리자 직위는 업무검색 결과에서 제외합니다.
// 단, '주무관'은 실무 담당자이므로 절대 제외하지 않습니다.
function isExcludedHqLeadershipRow(row) {
  const position = compactText(row && row.position || '');
  if (!position) return false;
  if (position.includes('주무관')) return false;

  const excluded = [
    '교육감', '부교육감', '교육장', '부교육장',
    '국장', '과장', '단장',
    '감사관', '담당관', '정책관', '기획관',
    '사무관', '장학관', '교육연구관', '연구관',
    '이사관', '부이사관', '서기관'
  ];
  return excluded.some(title => position.includes(title));
}

function hqRowMatchMeta(query, row) {
  const raw = String(query || '').trim();
  const whole = compactText(raw);
  const tokens = hqSearchTokens(raw).map(compactText).filter(Boolean);

  const duty = compactText(row.duty || '');
  const team = compactText(row.team || '');
  const dept = compactText(row.department || '');
  const pos = compactText(row.position || '');
  const phone = String(row.phone || '').replace(/\s+/g, '');
  const all = `${dept}${team}${pos}${duty}`;

  let score = 0;

  // 운영상 대표 담당 우선순위 보정
  // 검정고시 문의는 055-268-1135 담당자를 055-268-1134보다 먼저 안내합니다.
  // 단, 다른 업무 검색에는 영향을 주지 않습니다.
  if (whole.includes('검정고시')) {
    if (/1135$/.test(phone)) score += 35;
    if (/1134$/.test(phone)) score -= 5;
  }
  let matched = false;
  let exactInDuty = false;
  let exactInTeam = false;
  let allTokensInDuty = false;
  let teamTokenHits = 0;
  let dutyTokenHits = 0;

  if (whole) {
    const dutyIdx = duty.indexOf(whole);
    const teamIdx = team.indexOf(whole);
    if (teamIdx >= 0) {
      score += 260;
      exactInTeam = true;
      matched = true;
    }
    if (dutyIdx >= 0) {
      score += 220;
      exactInDuty = true;
      matched = true;
      // 담당업무 문장 앞부분에 검색어가 나올수록 '주 업무'일 가능성이 높습니다.
      if (dutyIdx === 0) score += 95;
      else if (dutyIdx <= 12) score += 70;
      else if (dutyIdx <= 35) score += 35;
      else score += 8;
    }
    if (dept.includes(whole)) { score += 100; matched = true; }
    if (!exactInDuty && !exactInTeam && all.includes(whole)) { score += 55; matched = true; }
  }

  for (const t of tokens) {
    let hit = false;
    if (team.includes(t)) { score += 80; teamTokenHits++; hit = true; }
    if (duty.includes(t)) { score += 52; dutyTokenHits++; hit = true; }
    if (!hit && dept.includes(t)) { score += 24; hit = true; }
    if (!hit && pos.includes(t)) { score += 5; hit = true; }
    if (hit) matched = true;
  }

  if (tokens.length) {
    allTokensInDuty = tokens.every(t => duty.includes(t));
    const allTokensSomewhere = tokens.every(t => `${dept}${team}${duty}`.includes(t));
    if (allTokensInDuty) score += 120;
    else if (allTokensSomewhere) score += 55;

    // 검색 핵심어가 담당명에도 잡히는 행을 우선합니다.
    if (teamTokenHits > 0) score += 55;
  }

  // '총괄'은 대표 담당을 찾을 때 강한 신호지만, 검색어 자체가 총괄이 아닐 때만 가점합니다.
  if (matched && /총괄/.test(duty) && !/총괄/.test(whole)) score += 45;

  // 검색어가 긴데 긴 업무설명 후반에 우연히 한 번 등장한 행은 낮춥니다.
  if (matched && duty.length > 260 && !exactInTeam && !allTokensInDuty) score -= 25;

  return {
    score,
    matched,
    exactInDuty,
    exactInTeam,
    allTokensInDuty,
    teamTokenHits,
    dutyTokenHits
  };
}

function rankHqContactRows(query, rows) {
  const raw = String(query || '').trim();
  const whole = compactText(raw);
  const tokens = hqSearchTokens(raw);
  if (!whole && !tokens.length) return [];

  // 0순위: 사용자가 입력한 글자가 업무분장에 그대로 들어 있으면 그 행을 우선 반환합니다.
  // 예) '위탁교육' → 담당업무에 '위탁 교육'처럼 띄어쓰기가 달라도 compactText 기준으로 일치.
  // 이렇게 하면 의미 매칭 점수가 낮더라도 공식 업무분장에 검색어가 명시된 담당자를 놓치지 않습니다.
  if (whole.length >= 2) {
    const literal = [];
    for (const row of (rows || [])) {
      if (isExcludedHqLeadershipRow(row)) continue;
      const duty = compactText(row && row.duty || '');
      const team = compactText(row && row.team || '');
      const dept = compactText(row && row.department || '');
      const dutyIdx = duty.indexOf(whole);
      const teamIdx = team.indexOf(whole);
      const deptIdx = dept.indexOf(whole);
      if (dutyIdx < 0 && teamIdx < 0 && deptIdx < 0) continue;

      let literalScore = 0;
      if (teamIdx >= 0) literalScore += 500;
      if (dutyIdx >= 0) {
        literalScore += 430;
        if (dutyIdx === 0) literalScore += 100;
        else if (dutyIdx <= 12) literalScore += 70;
        else if (dutyIdx <= 35) literalScore += 35;
      }
      if (deptIdx >= 0) literalScore += 180;
      if (/총괄/.test(duty) && !/총괄/.test(whole)) literalScore += 35;

      // 기존 운영 우선순위(예: 검정고시 1135 우선)도 그대로 반영합니다.
      const meta = hqRowMatchMeta(raw, row);
      literalScore += Math.max(0, meta.score);
      literal.push({ row, score: literalScore, dutyIdx, teamIdx });
    }

    if (literal.length) {
      literal.sort((a, b) =>
        b.score - a.score ||
        (a.teamIdx < 0 ? 1 : 0) - (b.teamIdx < 0 ? 1 : 0) ||
        (a.dutyIdx < 0 ? 999999 : a.dutyIdx) - (b.dutyIdx < 0 ? 999999 : b.dutyIdx) ||
        String(a.row.department).localeCompare(String(b.row.department), 'ko')
      );
      return literal.slice(0, 10).map(x => x.row);
    }
  }

  const ranked = [];
  for (const row of (rows || [])) {
    // 과장·사무관·국장·교육감·각종 담당관/장학관 등 간부 전화번호는 표출하지 않습니다.
    if (isExcludedHqLeadershipRow(row)) continue;

    const meta = hqRowMatchMeta(raw, row);
    if (!meta.matched || meta.score <= 0) continue;
    ranked.push({ row, ...meta });
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    Number(b.exactInTeam) - Number(a.exactInTeam) ||
    Number(b.exactInDuty) - Number(a.exactInDuty) ||
    String(a.row.department).localeCompare(String(b.row.department), 'ko')
  );

  if (!ranked.length) return [];

  const top = ranked[0];
  const second = ranked[1];

  // 담당명/담당업무가 검색어와 직접 맞고 2위와 차이가 충분하면 대표 담당 1명만 안내합니다.
  const strongPrimary =
    top.score >= 300 &&
    (top.exactInTeam || top.exactInDuty || top.allTokensInDuty) &&
    (!second || top.score - second.score >= 55);
  if (strongPrimary) return [top.row];

  // 애매할 때도 '관련 단어가 어딘가에 한 번 포함된 사람'을 전부 보여주지 않고
  // 최상위 결과와 점수 차가 작은 후보만 남깁니다.
  const minScore = Math.max(95, top.score - 85);
  const narrowed = ranked.filter(x => x.score >= minScore);
  return narrowed.slice(0, 10).map(x => x.row);
}

function loadPersistedHqContacts() {
  const saved = readJson(HQ_CONTACT_CACHE_FILE, null);
  if (!saved || !Array.isArray(saved.rows) || !saved.rows.length) return null;
  const updatedAt = Number(saved.updatedAt || 0);
  if (!updatedAt) return null;
  return { updatedAt, rows: saved.rows };
}

function savePersistedHqContacts(rows) {
  try {
    writeJson(HQ_CONTACT_CACHE_FILE, { updatedAt: Date.now(), rows });
  } catch (err) {
    console.error('본청 업무담당자 캐시 저장 오류:', err && err.message ? err.message : err);
  }
}

async function refreshGneHqContacts(timeoutMs = 8000) {
  if (GNE_HQ_REFRESH_PROMISE) return GNE_HQ_REFRESH_PROMISE;

  GNE_HQ_REFRESH_PROMISE = (async () => {
    const attempts = [];
    let rows = [];

    // 1차: 공식 업무검색 기본 주소
    try {
      const html = await fetchOfficialGneHtml(GNE_HQ_WORK_SEARCH_URL, timeoutMs);
      rows = parseGneHqWorkSearchResults(html);
      attempts.push(`기본:${rows.length}건/html${String(html || '').length}`);
    } catch (err) {
      attempts.push(`기본오류:${err && err.message ? err.message : err}`);
    }

    // 경남교육청 페이지는 기본 주소만 호출하면 결과 표가 비어 있고,
    // 검색 요청 형태(query string)가 붙었을 때 전체 업무표가 내려오는 경우가 있어
    // 같은 공식 페이지를 '빈 검색' 형태로 한 번 더 요청합니다.
    if (!rows.length) {
      try {
        const html = await fetchGneHqSearchFast('', timeoutMs);
        rows = parseGneHqWorkSearchResults(html);
        attempts.push(`검색화면:${rows.length}건/html${String(html || '').length}`);
      } catch (err) {
        attempts.push(`검색화면오류:${err && err.message ? err.message : err}`);
      }
    }

    // 3차: 페이지에 실제 form name이 노출되어 있으면 그 form을 찾아 빈 검색 제출
    if (!rows.length) {
      try {
        const landingHtml = await fetchOfficialGneHtml(GNE_HQ_WORK_SEARCH_URL, timeoutMs);
        const form = discoverGneHqSearchFormFromHtml(landingHtml);
        if (form && form.queryField) {
          const html = await fetchOfficialGneFormResult(form, '');
          rows = parseGneHqWorkSearchResults(html);
          attempts.push(`폼검색(${form.queryField}):${rows.length}건/html${String(html || '').length}`);
        } else {
          attempts.push('폼검색:검색필드없음');
        }
      } catch (err) {
        attempts.push(`폼검색오류:${err && err.message ? err.message : err}`);
      }
    }

    if (!rows.length) {
      throw new Error(`경남교육청 본청 업무분장 행을 찾지 못했습니다. [${attempts.join(' | ')}]`);
    }

    GNE_HQ_ALL_CONTACTS_CACHE = { updatedAt: Date.now(), rows };
    GNE_HQ_QUERY_CACHE.clear();
    savePersistedHqContacts(rows);
    console.log(`✅ 본청 업무담당자 캐시 갱신 완료: ${rows.length}건 (${attempts.join(' | ')})`);
    return rows;
  })().finally(() => {
    GNE_HQ_REFRESH_PROMISE = null;
  });

  return GNE_HQ_REFRESH_PROMISE;
}

async function getAllGneHqContacts() {
  const now = Date.now();

  // 1) 메모리의 최신 캐시가 있으면 카카오에는 즉시 응답합니다.
  if (GNE_HQ_ALL_CONTACTS_CACHE && now - GNE_HQ_ALL_CONTACTS_CACHE.updatedAt < HQ_CONTACT_ALL_CACHE_TTL_MS) {
    return GNE_HQ_ALL_CONTACTS_CACHE.rows;
  }

  // 2) Render 재시작 뒤에도 직전 공식 조회본이 남아 있으면 우선 사용합니다.
  //    카카오 스킬 요청 중에 582건짜리 홈페이지를 매번 내려받지 않도록 하기 위한 안전장치입니다.
  const persisted = loadPersistedHqContacts();
  if (persisted && now - persisted.updatedAt < HQ_CONTACT_PERSIST_MAX_AGE_MS) {
    GNE_HQ_ALL_CONTACTS_CACHE = persisted;
    // 오래된 캐시(30분 초과)는 사용자 응답과 별개로 백그라운드 갱신합니다.
    if (now - persisted.updatedAt >= HQ_CONTACT_ALL_CACHE_TTL_MS) {
      refreshGneHqContacts(8000).catch(err => {
        console.error('본청 업무담당자 백그라운드 갱신 오류:', err && err.message ? err.message : err);
      });
    }
    return persisted.rows;
  }

  // 3) 캐시가 전혀 없는 최초 1회만 짧게 실시간 조회합니다.
  //    실패하면 아래의 오래된 성공 캐시가 있을 때만 그 값을 사용합니다.
  try {
    return await refreshGneHqContacts(3600);
  } catch (err) {
    const stale = persisted || GNE_HQ_ALL_CONTACTS_CACHE;
    if (stale && Array.isArray(stale.rows) && stale.rows.length) {
      console.error('본청 업무담당자 실시간 갱신 실패 - 최근 성공 캐시 사용:', err && err.message ? err.message : err);
      return stale.rows;
    }
    throw err;
  }
}

async function searchGneHqContacts(query) {
  const core = normalizeHqContactSearchQuery(query);
  if (!core) return [];

  const cached = getFreshHqQueryCache(core);
  if (cached) return cached;

  const allRows = await getAllGneHqContacts();
  let filtered = rankHqContactRows(core, allRows);

  // 전체 표현이 업무분장과 맞지 않을 때만 일반적인 행동어를 덜어낸 핵심어로 재검색합니다.
  // 특정 업무를 하드코딩하지 않아 '제증명 발급', '검정고시 접수', '직업교육 지원' 등도 같이 보완됩니다.
  if (!filtered.length) {
    for (const fallback of hqContactFallbackQueries(core)) {
      const retry = rankHqContactRows(fallback, allRows);
      if (retry.length) {
        filtered = retry;
        break;
      }
    }
  }

  return saveHqQueryCache(core, filtered);
}

function extractHqWorkParamFromPayload(body) {
  const action = (body && body.action) || {};
  const params = action.params || {};
  const detailParams = action.detailParams || {};
  const blockName = String(
    (body && body.intent && body.intent.name) ||
    (body && body.userRequest && body.userRequest.block && body.userRequest.block.name) || ''
  );

  const preferredKeys = ['work', '업무', 'workQuery', 'business', 'query', 'keyword'];
  for (const key of preferredKeys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) {
      const core = hqContactQueryCore(value);
      if (core) return core;
    }
  }

  // 파라미터 이름을 다르게 만든 경우에도 '업무담당자 찾기' 블록 안에서는
  // @sys.text로 전달된 문자열 파라미터를 하나 찾아 사용합니다.
  if (/(업무담당자|담당자찾기|업무검색|담당자안내)/.test(compactText(blockName))) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.trim()) {
        const core = hqContactQueryCore(value);
        if (core && !/^(업무|담당자|업무담당자|담당자찾기)$/.test(compactText(core))) return core;
      }
      const d = detailParams[key];
      if (d && typeof d === 'object') {
        const candidate = d.origin || d.resolved || d.value;
        if (typeof candidate === 'string' && candidate.trim()) {
          const core = hqContactQueryCore(candidate);
          if (core && !/^(업무|담당자|업무담당자|담당자찾기)$/.test(compactText(core))) return core;
        }
      }
    }
  }
  return '';
}

function kakaoHqContactAskResponse() {
  return {
    version: '2.0',
    template: {
      outputs: [
        {
          basicCard: {
            title: '경상남도교육청 본청 업무담당자',
            description: '본청 업무분장 기준으로 담당자를 찾아드립니다.\n예) 다자녀, 제증명, 고등학교 전입학, 검정고시, 직업교육\n\n※ 초·중학교 전입학, 학원·교습소 등 지역교육지원청 담당 업무는 해당 교육지원청 누리집의 업무분장을 확인해 주세요.',
            buttons: [
              { label: '🔎 본청 업무담당자 검색', action: 'webLink', webLinkUrl: `${PUBLIC_BASE_URL}/staff-search` },
              { label: '🏫 지역교육청 안내', action: 'webLink', webLinkUrl: `${PUBLIC_BASE_URL}/staff-search?regional=1` }
            ]
          }
        }
      ]
    }
  };
}

function kakaoHqContactResponseText(query, contacts) {
  const limited = (contacts || []).slice(0, 3);
  if (!limited.length) {
    return `경상남도교육청 본청 업무검색에서 '${query}' 관련 담당자를 찾지 못했어요.\n업무명을 조금 더 구체적으로 입력해 주세요.`;
  }

  const lines = [`'${query}' 관련 본청 업무담당자를 찾았어요.`];
  limited.forEach((c, i) => {
    lines.push('');
    lines.push(`${i + 1}. ${c.department}${c.team ? ` / ${c.team}` : ''}`);
    lines.push(`☎ ${c.phone}`);
    lines.push(`업무: ${truncateOfficialDuty(c.duty, 135)}`);
  });
  if ((contacts || []).length > limited.length) {
    lines.push('');
    lines.push(`※ 검색 결과가 ${contacts.length}건이라 상위 ${limited.length}건만 표시했어요. 업무명을 더 구체적으로 입력하면 범위를 줄일 수 있어요.`);
  }
  lines.push('');
  lines.push('※ 경상남도교육청 본청 공식 업무분장 정보를 조회해 안내한 결과입니다.');
  lines.push('※ 초·중학교 전입학, 학원·교습소 등 지역교육지원청 담당 업무는 해당 교육지원청 누리집의 업무분장을 확인해 주세요.');
  return lines.join('\n').slice(0, 980);
}

async function kakaoHqContactResponse(intent) {
  const query = String((intent && intent.query) || '').trim();
  if (!query) return kakaoHqContactAskResponse();

  try {
    const contacts = await searchGneHqContacts(query);
    const text = kakaoHqContactResponseText(query, contacts);
    const outputs = [{ simpleText: { text } }];

    // 결과가 정확히 1건일 때만 바로 전화 버튼을 제공합니다.
    if (contacts.length === 1) {
      const callable = firstCallablePhone(contacts[0].phone);
      if (callable) {
        outputs.push({
          basicCard: {
            title: `${contacts[0].department}${contacts[0].team ? ` / ${contacts[0].team}` : ''}`,
            description: truncateOfficialDuty(contacts[0].duty, 180),
            buttons: [{ label: '☎ 담당자 전화', action: 'phone', phoneNumber: callable.replace(/-/g, '') }]
          }
        });
      }
    }

    return { version: '2.0', template: { outputs } };
  } catch (err) {
    console.error('본청 업무담당자 실시간 조회 오류:', err && err.message ? err.message : err);
    return {
      version: '2.0',
      template: {
        outputs: [
          { simpleText: { text: '현재 경상남도교육청 공식 업무분장 정보를 불러오지 못했어요.\n잘못된 담당자 정보를 임의로 안내하지 않습니다. 잠시 후 다시 이용해 주세요.' } }
        ]
      }
    };
  }
}

function getKakaoFailStreak(kakaoUserId) {
  if (!kakaoUserId) return 0;
  const entry = KAKAO_FAIL_STREAKS.get(kakaoUserId);
  if (!entry) return 0;
  if (Date.now() - entry.updatedAt > FAIL_STREAK_TTL_MS) {
    KAKAO_FAIL_STREAKS.delete(kakaoUserId);
    return 0;
  }
  return entry.count || 0;
}

function markKakaoFailure(kakaoUserId) {
  if (!kakaoUserId) return 1;
  const count = getKakaoFailStreak(kakaoUserId) + 1;
  KAKAO_FAIL_STREAKS.set(kakaoUserId, { count, updatedAt: Date.now() });
  return count;
}

function resetKakaoFailStreak(kakaoUserId) {
  if (!kakaoUserId) return;
  KAKAO_FAIL_STREAKS.delete(kakaoUserId);
}

function getKakaoTransferFailStreak(kakaoUserId) {
  if (!kakaoUserId) return { count: 0, highSchool: false };
  const entry = KAKAO_TRANSFER_FAIL_STREAKS.get(kakaoUserId);
  if (!entry) return { count: 0, highSchool: false };
  if (Date.now() - entry.updatedAt > FAIL_STREAK_TTL_MS) {
    KAKAO_TRANSFER_FAIL_STREAKS.delete(kakaoUserId);
    return { count: 0, highSchool: false };
  }
  return { count: entry.count || 0, highSchool: !!entry.highSchool };
}

function markKakaoTransferFailure(kakaoUserId, highSchool) {
  if (!kakaoUserId) return { count: 1, highSchool: !!highSchool };
  const prev = getKakaoTransferFailStreak(kakaoUserId);
  const next = {
    count: prev.count + 1,
    // 한 번이라도 고등학교 맥락이 확인되면 같은 연속 실패 흐름에서는 유지
    highSchool: !!(prev.highSchool || highSchool),
    updatedAt: Date.now()
  };
  KAKAO_TRANSFER_FAIL_STREAKS.set(kakaoUserId, next);
  return next;
}

function resetKakaoTransferFailStreak(kakaoUserId) {
  if (!kakaoUserId) return;
  KAKAO_TRANSFER_FAIL_STREAKS.delete(kakaoUserId);
}

function getTransferFailureContext(rawQuery, blocks, bestCandidate) {
  const q = compactText(expandQuery(rawQuery));
  const title = bestCandidate && bestCandidate.idx >= 0 && blocks[bestCandidate.idx]
    ? String(blocks[bestCandidate.idx].title || '')
    : '';

  const directTransfer = /(전입학|전학|학교옮|거주지이전)/.test(q);
  const candidateTransfer = /(전입학|전학|선배정|재배정|귀국자편입학)/.test(compactText(title));
  const explicitHigh = /(고등학교|고교|고딩|고등학생)/.test(q);
  const candidateHigh = /(고등학교|진로변경|귀국자편입학)/.test(compactText(title));
  const explicitNonHigh = /(중학교|중딩|중학생|초등학교|초딩|초등학생)/.test(q);

  return {
    isTransfer: directTransfer || candidateTransfer,
    // 중·초등학교가 명시되면 고등학교 GPT를 노출하지 않음
    highSchool: !explicitNonHigh && (explicitHigh || candidateHigh)
  };
}
const SESSION_MAX_MESSAGES = 6;

const STOPWORDS = new Set([
  '제가','저는','나는','우리는','우리','아이','애가','학생','관련','문의','질문','궁금','궁금해요',
  '어떻게','어디서','어디에','무엇','뭐가','뭔가요','하나요','해야','하면','할수','있나요','있어','있어요',
  '좀','조금','알려줘','알려주세요','주세요','싶어요','싶어','됩니다','되나요','되는지','그리고','근데','그런데'
]);

function compactText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\s·ㆍ,./#!$%^&*;:{}=\-_`~()'"?<>[\]…~～]/g, '');
}

function normalizeForSearch(s) {
  return expandQuery((s || '').toLowerCase())
    .replace(/[\n\r\t]/g, ' ')
    .replace(/[·ㆍ,./#!$%^&*;:{}=\-_`~()'"?<>[\]…~～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(s) {
  const normalized = normalizeForSearch(s);
  const words = normalized.split(' ').filter(Boolean);
  const out = [];
  for (const word of words) {
    const cleaned = word.replace(/(은|는|이|가|을|를|에|에서|으로|로|와|과|도|만|부터|까지|에게|한테|께|의)$/g, '');
    if (cleaned.length >= 2 && !STOPWORDS.has(cleaned) && !out.includes(cleaned)) out.push(cleaned);
  }
  return out.slice(0, 18);
}

function blockSearchText(block) {
  const responses = (block.responses || []).map(r => r.message || '').join(' ');
  const buttons = (block.responses || []).flatMap(r => (r.buttons || []).map(b => `${b.label || ''} ${b.value || ''}`)).join(' ');
  return `${block.title || ''} ${(block.utterances || []).join(' ')} ${responses} ${buttons}`;
}

// AI에 넘길 자료 후보 검색: 제목/발화/실제 답변 내용을 함께 봅니다.
// 기존 자모 유사도 하나에만 의존하지 않아 긴 자연어 질문의 오매칭을 줄입니다.
function aiCandidateBlocks(rawQuery, blocks, n = 6) {
  const keywords = extractKeywords(rawQuery);
  const queryExpanded = normalizeForSearch(rawQuery);
  const scored = blocks.map((b, i) => {
    if (i === FALLBACK_IDX) return { idx: i, score: -1 };
    const title = normalizeForSearch(b.title || '');
    const utterances = normalizeForSearch((b.utterances || []).join(' '));
    const responses = normalizeForSearch((b.responses || []).map(r => r.message || '').join(' '));
    let s = 0;

    for (const kw of keywords) {
      if (title.includes(kw)) s += 6;
      if (utterances.includes(kw)) s += 3.5;
      if (responses.includes(kw)) s += 1.8;
    }

    // 학교급이 질문에 명확히 들어간 경우 다른 학교급 블록이 지역명 때문에 위로 뜨는 것을 방지
    const qText = normalizeForSearch(rawQuery);
    const allText = `${title} ${utterances} ${responses}`;
    if (qText.includes('고등학교')) {
      if (allText.includes('고등학교')) s += 10;
      if (title.includes('중학교') || title.includes('초등학교')) s -= 12;
    } else if (qText.includes('중학교')) {
      if (allText.includes('중학교')) s += 10;
      if (title.includes('고등학교') || title.includes('초등학교')) s -= 12;
    } else if (qText.includes('초등학교')) {
      if (allText.includes('초등학교')) s += 10;
      if (title.includes('중학교') || title.includes('고등학교')) s -= 12;
    }

    // 질문에 없는 특수 유형·연락처 블록이 일반 절차보다 앞서는 현상 방지
    if (title.includes('담당자') && !/(담당자|전화|번호|연락처)/.test(qText)) s -= 12;
    if (title.includes('귀국') && !/(귀국|해외|외국)/.test(qText)) s -= 12;
    if (title.includes('진로변경') && !/(진로|특성화|일반고|일반계)/.test(qText)) s -= 6;

    // 오타 대응용 보조 점수. 긴 문장 전체의 유사도는 낮은 가중치만 줍니다.
    s += scoreAgainst(queryExpanded, b.title || '') * 1.4;
    for (const u of (b.utterances || [])) {
      s = Math.max(s, scoreAgainst(queryExpanded, u) * 1.8 + (s > 0 ? s : 0));
    }

    return { idx: i, score: s };
  });

  scored.sort((a, b) => b.score - a.score);
  const positive = scored.filter(x => x.score > 0).slice(0, n);
  // 검색어가 너무 짧아 점수가 전부 0이어도 기존 유사도 후보를 보조적으로 사용
  if (positive.length) return positive;
  return topCandidates(rawQuery, blocks, n);
}

function getSession(kakaoUserId) {
  if (!kakaoUserId) return [];
  const entry = KAKAO_SESSIONS.get(kakaoUserId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    KAKAO_SESSIONS.delete(kakaoUserId);
    return [];
  }
  return entry.messages || [];
}

function saveSession(kakaoUserId, messages) {
  if (!kakaoUserId) return;
  KAKAO_SESSIONS.set(kakaoUserId, {
    updatedAt: Date.now(),
    messages: messages.slice(-SESSION_MAX_MESSAGES)
  });
}

function rememberTurn(kakaoUserId, userText, assistantText) {
  if (!kakaoUserId) return;
  const history = getSession(kakaoUserId);
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });
  saveSession(kakaoUserId, history);
}

function isClearDirectMatch(rawQuery, best, blocks) {
  if (!rawQuery || best.idx < 0) return false;
  const q = compactText(rawQuery);
  const block = blocks[best.idx];
  if (!block) return false;

  // 제목/등록발화와 사실상 같은 짧은 질문은 기존 고정답변이 더 빠르고 안전합니다.
  const exact = q === compactText(block.title) || (block.utterances || []).some(u => q === compactText(u));
  if (exact) return true;

  // 긴 자연어 문장은 문자 겹침 점수가 높아져도 바로 단일 블록으로 보내지 않습니다.
  // 짧은 질문이면서 점수가 충분히 높은 경우에만 기존 블록으로 직행합니다.
  return q.length <= 14 && best.score >= 0.68;
}

function buildGroundingContext(candidates, blocks) {
  const chunks = [];
  let total = 0;
  for (const c of candidates) {
    const b = blocks[c.idx];
    if (!b) continue;
    const responseText = (b.responses || []).map((r, j) => {
      const buttons = (r.buttons || []).map(btn => {
        if (btn.type === 'url') return `[링크: ${btn.label || ''} ${btn.value || ''}]`;
        if (btn.type === 'phone') return `[전화: ${btn.label || ''} ${btn.value || ''}]`;
        return `[버튼: ${btn.label || ''}]`;
      }).join(' ');
      return `응답${j + 1}: ${r.message || ''} ${buttons}`;
    }).join('\n');
    const chunk = `\n[자료 ${chunks.length + 1}]\n제목: ${b.title || ''}\n등록 발화: ${(b.utterances || []).join(' / ')}\n${responseText}`;
    if (total + chunk.length > 12000) break;
    chunks.push(chunk);
    total += chunk.length;
  }
  return chunks.join('\n');
}

const KAKAO_BLOCK_ID_OVERRIDES = Object.freeze({
  "챗봇 이용 안내": "6a4cb8c65ee4c08b0a7e49d2",
  "질문 인식 불가 안내": "6a68096268acf42eb9607e01",
  "제증명 종합 안내": "6a0ea9d924bd2a247fde2a45",
  "졸업증명서": "6a47545a01d198c4c6844cf5",
  "재학증명서": "6a4ca674457c528697144a22",
  "생활기록부": "6a4f0de8178bd9946a58e6ad",
  "성적증명서": "6a47564a1c43d2c132f18fbe",
  "제적증명서": "6a4ca7a1178bd9946a57f271",
  "정원외관리증명서": "6a4ca845457c528697144a92",
  "경력증명서": "6a583f8068acf42eb95c641d",
  "퇴직증명원": "6a58620f95f722d77d9169cf",
  "개명 후 제증명 발급": "6a4ca9f15ee4c08b0a7e41d7",
  "제증명 구비서류": "6a4cb4782c03941dfb900776",
  "영문증명서": "6a4f0ef1457c528697154767",
  "검정고시 관련 제증명": "6a4f19ff178bd9946a58e83d",
  "검정고시개명": "6a62ee7ebfeff424f8527fad",
  "학원 관련 제증명": "6a4f40895ee4c08b0a7f4d3b",
  "민원실 이용 안내": "6a4f48505ee4c08b0a7f4e84",
  "일대일 채팅 상담 안내": "6a50688b2c03941dfb917d0f",
  "연수이수확인서": "6a58662bfd013545b641a6e6",
  "북한이탈주민 학력증명서": "6a58698dfb99c80dbe7cdff5",
  "팩스민원": "6a58929795f722d77d9174a0",
  "정보공개청구": "6a66a2426156d57563047b5a",
  "교원자격 무시험검정": "6a66c1c5fb99c80dbe808d91",
  "칭찬합시다": "6a685285b11ba04bddec05f7",
  "갑질직장내괴롭힘신고": "6a68536abfeff424f8539782",
  "국민신문고": "6a66a77c68acf42eb960239c",
  "교육감에게 바란다": "6a68517afd013545b645d156",
  "국민공무원제안": "6a686840b11ba04bddec094d",
  "교원자격증 재교부": "6a66bf214ea9d954e49963ae",
  "안전신문고": "6a6859414ea9d954e499d988",
  "신고센터": "6a685758b11ba04bddec06e3",
  "성희롱성폭행 신고센터": "6a685b516156d5756304f6b2",
  "불법사교육신고센터": "6a68585b68acf42eb960a0ba",
  "감사반장에게 바란다": "6a685c8e6156d5756304f6e1",
  "교육감신문고 부패비리신고": "6a685aabbfeff424f85398c0",
  "부패공익신고": "6a68133b95f722d77d956673",
  "입학 전 선배정": "6a62b1724ea9d954e498a1be",
  "타 학군 재배정": "6a62b8516156d5756303c753",
  "수능 원서접수": "6a62bfae6156d5756303c914",
  "수능 원서접수 기간": "6a62c00dfb99c80dbe7fdfdd",
  "대입정보센터": "6a69629ebfeff424f853e06d",
  "꿈디딤카드 종합 안내": "6a62bfedbfeff424f85275e6",
  "꿈디딤카드 재사용재발급": "6a62c84c4ea9d954e498a57e",
  "꿈디딤카드 결제오류": "6a62c90eb11ba04bddeadffa",
  "꿈디딤카드 미지급": "6a62c9a14ea9d954e498a5da",
  "꿈디딤카드 잔액 확인": "6a62cb3068acf42eb95f6e21",
  "고등학교전입학": "6a62cda8fd013545b644a4e4",
  "고등학교전입학제출서류": "6a62ce0fb11ba04bddeae0bb",
  "초중학교전입학": "6a62cf5e95f722d77d945485",
  "진로변경 전입학": "6a686e23bfeff424f8539d2d",
  "고등학교 귀국자 편입학": "6a686f9c68acf42eb960a6c4",
  "거점형연계형 돌봄기관": "6a681a106156d5756304e281",
  "유아학비": "6a671131bfeff424f8533435",
  "유아학비 신청 및 지급방법": "6a6711f06156d57563048baf",
  "특수교육대상자 선정배치": "6a67148e6156d57563048c02",
  "사립유치원 무상교육": "6a6714b3b11ba04bddeba382",
  "유치원 일반 안내": "6a62e4a04ea9d954e498adfc",
  "행복학교": "6a671714b11ba04bddeba3d6",
  "미래교육지구": "6a671740b11ba04bddeba404",
  "학부모교육": "6a6717466156d57563048cb5",
  "경남교육청 위치": "6a66acf1fb99c80dbe808a50",
  "아이톡톡아이북": "6a66bc94bfeff424f85325b1",
  "청사 배치": "6a62f15368acf42eb95f75b9",
  "학사일정": "6a66b2f2bfeff424f853244b",
  "학교찾기": "6a68672395f722d77d958371",
  "신이설학교 현황": "6a61c81c4ea9d954e4982755",
  "경남교육청 공식SNS": "6a686c48fb99c80dbe81097f",
  "교육지원청 안내": "6a686b2bfb99c80dbe810946",
  "스승찾기": "6a62d1d668acf42eb95f6f4c",
  "경상남도교육청 시설개방": "6a6848f06156d5756304eba5",
  "학교시설 예약": "6a62d47ebfeff424f8527c2d",
  "학교시설 사용료": "6a62d5016156d5756303cf26",
  "경남교육감인수위원회 백서": "6a6868c1bfeff424f8539ae9",
  "교명 변경학교": "6a61c91d6156d57563033b4a",
  "경남교육소식지신청및해지": "6a61c8e0bfeff424f851f196",
  "교육환경보호구역": "6a6816e5fb99c80dbe80ea9c",
  "학교안전공제회": "6a68189dfb99c80dbe80eee7",
  "검정고시 종합 안내": "6a62e58dfb99c80dbe7fe7b2",
  "2026년 제2회 검정고시": "6a62e5d095f722d77d945c73",
  "검정고시 자주 묻는 질문": "6a62e8d0bfeff424f8527ec8",
  "검정고시 제출서류": "6a62eb9bfb99c80dbe7fe899",
  "공기정화장치": "6a61c646fd013545b6441bfb",
  "공간재구조화사업": "6a61c6a66156d57563033af0",
  "교육급여": "6a61a87995f722d77d93c279",
  "다자녀카드사업안내": "6a61b8354ea9d954e4981dbf",
  "다자녀카드사용처안내": "6a61bfc4fb99c80dbe7f4850",
  "경남교육복지정책": "6a686a2768acf42eb960a36e",
  "교권 심리상담": "6a61c5706156d575630337ad",
  "지능형 과학실": "6a62af2868acf42eb95f68b2",
  "AI디지털 활용 연구선도학교": "6a62af44fd013545b644a008",
  "AI 중점학교": "6a62afedfb99c80dbe7fdd79",
  "적극행정": "6a62d3354ea9d954e498ab8c",
  "적극행정 공무원 추천": "6a62d35dfd013545b644a6d1",
  "학교폭력 불복절차": "6a61c7c968acf42eb95ededa",
  "시험정보": "6a685dda6156d5756304f728",
  "구인구직포털": "6a685e79fb99c80dbe81068e",
  "교육공무직원 채용 안내": "6a61c67668acf42eb95edeb3",
  "고등학교 전학 담당자": "6a6ae04495f722d77d962d0a",
  "창원 중학교 전입학 담당자": "6a6ae1ca4ea9d954e49a82c5",
  "창원 중학교 신입생 배정 담당자": "6a6ae2a14ea9d954e49a82db",
  "검정고시 담당자": "6a702f88b11ba04bddedba9a",
  "학원안내": "6a61aa1e4ea9d954e49817ef",
  "평생교육시설": "6a6854f6bfeff424f85397c6"
});

// 카카오 블록 ID 추출
// scenarios.json에 id가 없더라도 meta의 '블록 ID: ...'에서 찾아 사용합니다.
// 유효한 ID를 찾지 못하면 block 액션을 쓰지 않고 message 방식으로 안전하게 되돌립니다.
function getKakaoBlockId(block) {
  if (!block) return '';
  const directId = String(block.id || '').trim();
  if (/^[0-9a-f]{24}$/i.test(directId)) return directId;

  const meta = String(block.meta || '');
  const m = meta.match(/블록\s*ID\s*:\s*([0-9a-f]{24})/i);
  if (m && m[1]) return m[1];

  const byTitle = KAKAO_BLOCK_ID_OVERRIDES[String(block.title || '').trim()] || '';
  if (/^[0-9a-f]{24}$/i.test(byTitle)) return byTitle;

  return '';
}

function makeKakaoQuickReply(block) {
  const title = String((block && block.title) || '').trim();
  const blockId = getKakaoBlockId(block);
  const label = title.slice(0, 20);

  if (blockId) {
    return {
      label,
      action: 'block',
      blockId,
      messageText: title
    };
  }

  return {
    label,
    action: 'message',
    messageText: title
  };
}

const LEGACY_BLOCK_REFERENCE_ALIASES = Object.freeze({
  '경남교육청위치':'경남교육청 위치',
  '제증명 발급':'제증명 종합 안내',
  '검정고시':'검정고시 종합 안내',
  '수능원서접수':'수능 원서접수',
  '수능원서접수 - 사본 (1)':'수능 원서접수 기간',
  '꿈디딤카드':'꿈디딤카드 종합 안내',
  '일대일요청시':'일대일 채팅 상담 안내',
  '검정고시합격성적':'검정고시 관련 제증명',
  '꿈디딤결제오류':'꿈디딤카드 결제오류',
  '꿈디딤미지급':'꿈디딤카드 미지급',
  '꿈디딤재사용재발급':'꿈디딤카드 재사용재발급',
  '꿈디딤잔액확인':'꿈디딤카드 잔액 확인',
  '청사배치도':'청사 배치',
  '민원실위치':'민원실 이용 안내',
  '학교시설사용료':'학교시설 사용료',
  '검정고시 - 사본 (1)':'2026년 제2회 검정고시',
  '검정고시자주묻는질문':'검정고시 자주 묻는 질문',
  '검정고시제출서류':'검정고시 제출서류',
  '정원외관리증명서초중':'정원외관리증명서'
});

function findBlockForKakaoReference(ref, blocks) {
  const text = String(ref || '').trim();
  if (!text) return null;
  // value 안에 [24자리 블록ID]가 있는 경우 최우선
  const idMatch = text.match(/\[([0-9a-f]{24})\]/i);
  if (idMatch) {
    const byId = blocks.find(b => getKakaoBlockId(b).toLowerCase() === idMatch[1].toLowerCase());
    if (byId) return byId;
  }
  const clean = text.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  const aliasTitle = LEGACY_BLOCK_REFERENCE_ALIASES[clean];
  if (aliasTitle) {
    const aliasBlock = blocks.find(b => (b.title || '').trim() === aliasTitle);
    if (aliasBlock) return aliasBlock;
  }
  const direct = blocks.find(b => (b.title || '').trim() === clean || compactText(b.title || '') === compactText(clean));
  if (direct) return direct;
  const routedTitle = EXACT_QUERY_ROUTES[compactText(clean)];
  if (routedTitle) return blocks.find(b => (b.title || '').trim() === routedTitle) || null;
  const result = smartMatch(clean, blocks);
  return result.matched && result.idx >= 0 ? blocks[result.idx] : null;
}

function needsTransferSchoolLevel(rawQuery) {
  const q = compactText(expandQuery(rawQuery));
  const isTransfer = /(전입학|전학|학교옮|거주지이전)/.test(q);
  const hasSchoolLevel = /(고등학교|중학교|초등학교)/.test(q);
  const specialTransfer = /(귀국|해외|외국|진로변경|특성화고|일반고|선배정|재배정)/.test(q);
  return isTransfer && !hasSchoolLevel && !specialTransfer;
}

function kakaoTransferSchoolLevelResponse(blocks) {
  const quickReplies = [];
  const high = blocks.find(b => (b.title || '').trim() === '고등학교전입학');
  const middle = blocks.find(b => (b.title || '').trim() === '초중학교전입학');

  if (high) {
    const q = makeKakaoQuickReply(high);
    q.label = '고등학교 전입학';
    quickReplies.push(q);
  }
  if (middle) {
    const q = makeKakaoQuickReply(middle);
    // 실제 연결 블록은 '초중학교전입학'이지만 이용자에게는 중학교 선택지로 표시
    q.label = '중학교 전입학';
    quickReplies.push(q);
  }

  quickReplies.push({ label: '☎ 콜센터 연결', action: 'message', messageText: '콜센터' });

  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: '전학하려는 학생의 학교급을 선택해주세요.\n학교급에 따라 전입학 절차가 달라요.' } }],
      quickReplies: quickReplies.slice(0, 10)
    }
  };
}

function buildBlockQuickReplies(block, blocks) {
  const out = [];
  (block.quick_replies || []).forEach(qr => {
    // 이용자에게 보이는 label이 현재 title과 더 잘 맞는 경우가 많아 label을 먼저 확인
    const target = findBlockForKakaoReference(qr.label, blocks) || findBlockForKakaoReference(qr.block, blocks);
    if (target) {
      const item = makeKakaoQuickReply(target);
      item.label = String(qr.label || target.title || '').slice(0,20);
      out.push(item);
    } else if (qr.label) {
      out.push({ label:String(qr.label).slice(0,20), action:'message', messageText:qr.label });
    }
  });
  (block.responses || []).forEach(r => (r.buttons || []).forEach(b => {
    if (b.type !== 'block') return;
    const target = findBlockForKakaoReference(b.value, blocks) || findBlockForKakaoReference(b.label, blocks);
    if (target) {
      const item = makeKakaoQuickReply(target);
      item.label = String(b.label || target.title || '').slice(0,20);
      out.push(item);
    } else if (b.label) {
      out.push({ label:String(b.label).slice(0,20), action:'message', messageText:b.label });
    }
  }));
  // 중복 제거
  const seen = new Set();
  return out.filter(x => {
    const key = `${x.label}|${x.blockId || x.messageText || ''}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,10);
}

function kakaoFallbackResponse(utterance, blocks, options = {}) {
  const failCount = Number(options.failCount || 0);
  const transferFailCount = Number(options.transferFailCount || 0);
  const showTransferAi = !!options.showTransferAi && transferFailCount >= TRANSFER_AI_ESCALATE_AT;
  const escalated = failCount >= FAIL_STREAK_ESCALATE_AT;
  const cands = topCandidates(utterance, blocks, 3);

  // 관련 후보는 카카오의 노란색 바로연결(quickReplies)로 표시합니다.
  const quickReplies = cands
    .map(c => makeKakaoQuickReply(blocks[c.idx]))
    .filter(q => q.label);

  // 1회 실패: 상담/전화 버튼을 띄우지 않고 챗봇에 한 번 더 질문하도록 유도합니다.
  // 2회 이상 연속 실패: 1:1 채팅상담 -> 콜센터 순서로 상담 수단을 노출합니다.
  const cardButtons = [];

  if (escalated) {
    // 고등학교 전학 관련 질문을 연속 2회 이상 못 알아들었을 때만
    // 참고용 GPT 링크를 상담 수단보다 먼저 노출합니다.
    if (showTransferAi) {
      cardButtons.push({
        label: '🤖 고등학교 전입학 AI 참고',
        action: 'webLink',
        webLinkUrl: HIGH_SCHOOL_TRANSFER_GPT_URL
      });
    }

    const chatBlock = blocks.find(b => (b.title || '').trim() === '일대일 채팅 상담 안내');
    const chatBlockId = getKakaoBlockId(chatBlock);
    if (chatBlockId) {
      cardButtons.push({
        label: '1:1 채팅상담',
        action: 'block',
        blockId: chatBlockId,
        messageText: '1:1 채팅상담'
      });
    } else {
      // 혹시 블록 ID를 찾지 못해도 스킬 전체가 깨지지 않도록 message 방식으로 안전하게 처리
      cardButtons.push({
        label: '1:1 채팅상담',
        action: 'message',
        messageText: '1:1 채팅상담'
      });
    }

    cardButtons.push({
      label: '☎경남교육콜센터 전화연결',
      action: 'phone',
      phoneNumber: '0552681004'
    });
  }

  const text = escalated
    ? (showTransferAi
      ? '제가 전학 관련 질문을 계속 정확히 이해하지 못했어요😥\n아래 관련 항목을 선택하시거나 고등학교 전입학 AI 안내를 참고해 주세요.\n\n💡AI 안내는 참고용이며, 실제 전입학 절차는 교육청의 공식 안내를 통해 다시 한 번 확인해 주세요.'
      : '제가 질문을 계속 정확히 이해하지 못했어요😥\n조금 더 구체적으로 말씀해주시거나 아래 관련 항목을 선택해주세요.\n\n💡궁금증이 해결되지 않았다면 1:1 채팅상담 또는 경남교육콜센터(055-268-1004)를 이용해주세요🤗')
    : '제가 질문을 정확히 이해하지 못했어요😥\n조금 더 구체적으로 다시 말씀해주시거나 아래 관련 항목을 선택해주세요.';

  // 혹시 후보가 중복된 경우 제거
  const seen = new Set();
  const deduped = quickReplies.filter(q => {
    const key = `${q.label}|${q.blockId || q.messageText || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const textCard = { text };
  if (cardButtons.length) textCard.buttons = cardButtons.slice(0, 3);

  return {
    version: '2.0',
    template: {
      outputs: [{ textCard }],
      quickReplies: deduped.slice(0, 10)
    }
  };
}


function withStaffSearchQuickReply(payload) {
  if (!payload || !payload.template) return payload;

  const outputBlob = JSON.stringify(payload.template.outputs || []);
  const hasContactInfo = /(담당자|담당부서|담당과|담당업무|문의처|문의전화)/.test(outputBlob)
    || /055[- ]?\d{3,4}[- ]?\d{4}/.test(outputBlob);

  // 담당자 관련 정보가 없는 일반 답변에는 노출하지 않습니다.
  if (!hasContactInfo) return payload;

  // 이미 본청/지역청 검색 링크가 직접 표시된 카드라면 중복 노출하지 않습니다.
  if (outputBlob.includes('/staff-search')) return payload;

  const quickReplies = Array.isArray(payload.template.quickReplies)
    ? payload.template.quickReplies.slice()
    : [];

  const label = '담당자검색(본청, 지역청)';
  if (!quickReplies.some(q => String((q && q.label) || '') === label)) {
    quickReplies.unshift({
      label,
      action: 'message',
      messageText: '업무담당자'
    });
  }

  payload.template.quickReplies = quickReplies.slice(0, 10);
  return payload;
}

function kakaoAiResponse(text, candidates, blocks) {
  const safeText = (text || '').trim().slice(0, 950);
  const quickReplies = candidates
    .slice(0, 3)
    .map(c => makeKakaoQuickReply(blocks[c.idx]))
    .filter(q => q.label);

  quickReplies.push({ label: '☎ 콜센터 연결', action: 'message', messageText: '콜센터' });

  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: safeText || '관련 자료를 확인하지 못했어요. 콜센터 또는 담당부서로 문의해주세요.' } }],
      quickReplies: quickReplies.slice(0, 10)
    }
  };
}

async function askClaudeGrounded({ utterance, kakaoUserId, candidates, blocks }) {
  if (!AI_ENABLED) throw new Error('AI 환경변수가 설정되지 않았습니다.');

  const history = getSession(kakaoUserId);
  const context = buildGroundingContext(candidates, blocks);
  const historyText = history.length
    ? history.map(m => `${m.role === 'user' ? '이용자' : '챗봇'}: ${m.content}`).join('\n')
    : '(이전 대화 없음)';

  const system = [
    '당신은 경상남도교육청 민원 안내 챗봇입니다.',
    '아래 제공된 내부 시나리오 자료에 적힌 내용만 근거로 답변하세요.',
    '자료에 없는 사실, 법령, 담당부서, 연락처, 날짜, 자격요건을 추측하거나 만들어내지 마세요.',
    '질문에 필요한 조건이 부족하면 임의로 결론 내리지 말고 한 번에 1~2개의 짧은 확인 질문을 하세요.',
    '여러 자료가 충돌하거나 어떤 제도인지 불명확하면 그 점을 밝히고 확인 질문을 하세요.',
    '답변은 카카오톡에서 읽기 쉽게 6~8문장 이내로 간결하게 작성하세요.',
    '개인정보를 요구하지 마세요. 주민등록번호, 상세 주소, 학생 이름 같은 정보는 받지 마세요.',
    '자료에서 확인할 수 없으면 "제공된 안내자료만으로는 확인하기 어렵습니다"라고 말하고 콜센터 또는 담당부서 문의를 안내하세요.'
  ].join('\n');

  const userContent = `이전 대화:\n${historyText}\n\n현재 이용자 질문:\n${utterance}\n\n참고 가능한 민원 안내자료:\n${context}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4200);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 650,
        temperature: 0.1,
        system,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Anthropic API ${r.status}: ${body.slice(0, 300)}`);
    }
    const data = await r.json();
    const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    if (!text) throw new Error('AI가 빈 응답을 반환했습니다.');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function logMissed(query, bestGuessTitle, bestGuessScore) {
  const list = readJson(MISSED_PATH, []);
  list.push({ time: new Date().toISOString(), query, bestGuessTitle: bestGuessTitle||'', bestGuessScore: bestGuessScore!=null?Number(bestGuessScore.toFixed(2)):'' });
  if (list.length > 5000) list.shift();
  writeJson(MISSED_PATH, list);
}

// 통계용: 맞았든 못 맞았든 모든 질문을 기록
function trackQuery(query, matchedTitle, matched, source, visitorId) {
  const list = readJson(QUERIES_PATH, []);
  list.push({ time: new Date().toISOString(), query: query||'', matchedTitle: matchedTitle||'', matched: !!matched, source: source||'unknown', visitorId: visitorId||'' });
  if (list.length > 20000) list.shift();
  writeJson(QUERIES_PATH, list);
}

function requireAdmin(req, res, next) {
  // 대시보드 fetch는 헤더로, CSV 다운로드/링크 클릭은 쿼리스트링(?token=)으로 넘어올 수 있어 둘 다 허용합니다.
  const given = (req.header('x-admin-token') || req.query.token || '').toString().trim();
  if (given !== ADMIN_TOKEN.trim()) {
    return res.status(401).json({ error: '관리자 토큰이 올바르지 않습니다.' });
  }
  next();
}

// ---- 놓친 질문 그룹핑(빈도순) + CSV 유틸 ----
// 같은 뜻의 질문이 표현만 조금씩 다르게 5000건까지 쌓이면 관리자가 무엇부터
// 학습시켜야 할지 알기 어려워, compactText 기준으로 묶어 빈도순으로 보여줍니다.
function normalizeMissedKey(query) {
  return compactText(query || '');
}

function getMissedSummary() {
  const list = readJson(MISSED_PATH, []);
  const learned = readJson(LEARNED_PATH, []);
  const learnedKeys = new Set(learned.map(e => compactText(e.text || '')));

  const groups = new Map();
  list.forEach(entry => {
    const key = normalizeMissedKey(entry.query);
    if (!key) return;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        sample: entry.query || '',
        count: 0,
        firstSeen: entry.time || '',
        lastSeen: entry.time || '',
        bestGuessTitle: entry.bestGuessTitle || '',
        bestGuessScore: entry.bestGuessScore
      });
    }
    const g = groups.get(key);
    g.count += 1;
    if (!g.firstSeen || (entry.time && entry.time < g.firstSeen)) g.firstSeen = entry.time || g.firstSeen;
    if (!g.lastSeen || (entry.time && entry.time >= g.lastSeen)) {
      g.lastSeen = entry.time || g.lastSeen;
      g.bestGuessTitle = entry.bestGuessTitle || g.bestGuessTitle;
      g.bestGuessScore = entry.bestGuessScore;
      g.sample = entry.query || g.sample;
    }
  });

  const result = [...groups.values()].map(g => ({ ...g, alreadyLearned: learnedKeys.has(g.key) }));
  result.sort((a, b) => b.count - a.count || String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return result;
}

function toCsv(rows, columns) {
  const escapeCell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = columns.map(c => escapeCell(c.label)).join(',');
  const body = (rows || []).map(row => columns.map(c => escapeCell(row[c.key])).join(',')).join('\n');
  return '\uFEFF' + header + '\n' + body; // BOM: 엑셀에서 한글 깨짐 방지
}

// ============ 공개 API (누구나 호출 가능) ============

// 생성형 AI 연결 상태 확인용 (API 키 자체는 절대 노출하지 않음)
app.get('/api/ai-status', (req, res) => {
  res.json({ enabled: AI_ENABLED, model: ANTHROPIC_MODEL || '', provider: 'anthropic' });
});

// 시나리오 데이터 전체 (웹챗봇이 여기서 최신 데이터를 받아가도록 할 수 있음)
app.get('/api/scenarios', (req, res) => {
  res.json(SCENARIOS);
});

// 학습된 표현 목록 (읽기 전용, 공개) — 웹챗봇이 매칭 시 함께 참고하도록
app.get('/api/learned', (req, res) => {
  res.json(readJson(LEARNED_PATH, []));
});

// 텍스트 질문에 대한 매칭 결과 (웹챗봇에서 서버 매칭을 쓰고 싶을 때)
app.post('/api/match', (req, res) => {
  const query = (req.body && req.body.query) || '';
  const blocks = getEffectiveUtterances();
  const result = smartMatch(query, blocks);
  if (!result.matched || result.idx < 0) {
    const best = result.candidates && result.candidates[0];
    logMissed(query, best ? blocks[best.idx].title : '', best ? best.score : 0);
    return res.json({
      matched: false,
      reason: result.reason,
      fallback: BLOCKS[FALLBACK_IDX],
      candidates: (result.candidates || []).slice(0,3).map(c=>({title:blocks[c.idx].title, idx:c.idx, score:Number(c.score.toFixed(2))}))
    });
  }
  res.json({ matched: true, idx: result.idx, score: result.score, reason: result.reason, block: BLOCKS[result.idx] });
});

// 놓친 질문 기록만 남기고 싶을 때 (웹챗봇의 LOG_WEBHOOK_URL 로 연결)
app.post('/api/log', (req, res) => {
  const { query, bestGuessTitle, bestGuessScore } = req.body || {};
  logMissed(query||'', bestGuessTitle, typeof bestGuessScore==='number'?bestGuessScore:Number(bestGuessScore)||undefined);
  res.json({ status: 'ok' });
});

// 통계용: 모든 질문 기록 (맞았든 못 맞았든) — 웹챗봇이 질문할 때마다 호출
app.post('/api/track', (req, res) => {
  const { query, matchedTitle, matched, source, visitorId } = req.body || {};
  trackQuery(query, matchedTitle, matched, source || 'web', visitorId);
  res.json({ status: 'ok' });
});

// 본청 업무담당자 검색용 모바일 페이지
// 카카오 인앱브라우저에서도 별도 업무 발화 등록 없이 검색할 수 있습니다.
app.get('/staff-search', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>경상남도교육청 본청 업무담당자 검색</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;color:#222}
  .wrap{max-width:720px;margin:0 auto;padding:18px 14px 40px}
  .card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  h1{font-size:20px;margin:0 0 6px}.sub{font-size:14px;line-height:1.6;color:#666;margin-bottom:14px}
  .scope{background:#fff7cc;border:1px solid #ffe36b;border-radius:12px;padding:11px 12px;font-size:13px;line-height:1.55;color:#554700;margin-bottom:15px}
  .search{display:flex;gap:8px}.search input{flex:1;min-width:0;height:46px;border:1px solid #cfd6dd;border-radius:10px;padding:0 13px;font-size:16px;outline:none}.search input:focus{border-color:#777}
  .search button,.region-toggle{height:46px;border:0;border-radius:10px;padding:0 17px;font-size:15px;font-weight:700;background:#fee500;color:#191919;cursor:pointer}
  .region-toggle{width:100%;margin-top:12px;background:#eef2f6}
  .examples{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.chip{border:1px solid #e1e5e9;background:#fff;border-radius:999px;padding:7px 10px;font-size:13px;cursor:pointer}
  #regionBox{display:none;margin-top:12px;padding-top:13px;border-top:1px solid #edf0f2}.region-title{font-size:14px;font-weight:800;margin-bottom:4px}.region-help{font-size:12px;line-height:1.5;color:#777;margin-bottom:10px}
  .regions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.region-link{display:block;text-decoration:none;text-align:center;border:1px solid #dfe4e8;background:#fff;border-radius:10px;padding:10px 7px;color:#222;font-size:13px;font-weight:700}
  #status{font-size:14px;color:#666;margin:16px 2px 8px}.result{background:#fff;border-radius:14px;padding:15px 16px;margin-top:10px;box-shadow:0 1px 8px rgba(0,0,0,.05)}
  .dept{font-weight:800;font-size:16px;margin-bottom:6px}.phone{display:inline-block;margin:2px 0 8px;font-weight:700;color:#1b5dbf;text-decoration:none}.duty{font-size:14px;line-height:1.55;white-space:pre-wrap;color:#444}
  .notice{font-size:12px;line-height:1.55;color:#777;margin-top:16px}.empty{background:#fff;border-radius:14px;padding:18px;margin-top:10px;color:#555}
  @media(min-width:560px){.regions{grid-template-columns:repeat(3,minmax(0,1fr))}}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>본청 업무담당자 검색</h1>
    <div class="sub">찾으시는 <b>업무명만</b> 입력해 주세요. ‘담당자’라고 붙이지 않아도 됩니다.<br>경상남도교육청 <b>본청</b> 공식 업무분장 정보를 기준으로 검색합니다.</div>
    <div class="scope"><b>지역 업무는 별도 확인이 필요합니다.</b><br>초·중학교 전입학, 학원·교습소 등 지역교육지원청 담당 업무는 아래 <b>지역교육청 안내</b>에서 해당 교육지원청 누리집의 업무분장을 확인해 주세요.</div>
    <div class="search">
      <input id="q" type="search" placeholder="예: 다자녀" autocomplete="off">
      <button id="btn" type="button">검색</button>
    </div>
    <div class="examples">
      <button class="chip" data-q="다자녀">다자녀</button>
      <button class="chip" data-q="제증명">제증명</button>
      <button class="chip" data-q="고등학교 전입학">고등학교 전입학</button>
      <button class="chip" data-q="검정고시">검정고시</button>
      <button class="chip" data-q="직업교육">직업교육</button>
    </div>
    <div id="status"></div>
    <div id="results"></div>
    <button id="regionToggle" class="region-toggle" type="button">🏫 지역교육청 안내 보기</button>
    <div id="regionBox">
      <div class="region-title">지역교육지원청 누리집</div>
      <div class="region-help">지역을 선택한 뒤 해당 교육지원청의 조직·업무안내(업무분장)를 확인해 주세요.</div>
      <div class="regions">
        <a class="region-link" href="https://cwedu.gne.go.kr/cwedu/jo/jobshare/selectJobShareView.do?mi=6769" target="_blank" rel="noopener">창원</a>
        <a class="region-link" href="https://jjedu.gne.go.kr/jjedu/jo/jobshare/selectJobShareView.do?mi=6776" target="_blank" rel="noopener">진주</a>
        <a class="region-link" href="https://tyedu.gne.go.kr/tyedu/jo/jobshare/selectJobShareView.do?mi=6787" target="_blank" rel="noopener">통영</a>
        <a class="region-link" href="https://scedu.gne.go.kr/scedu/jo/jobshare/selectJobShareView.do?mi=6778" target="_blank" rel="noopener">사천</a>
        <a class="region-link" href="https://ghedu.gne.go.kr/ghedu/jo/jobshare/selectJobShareView.do?mi=6752" target="_blank" rel="noopener">김해</a>
        <a class="region-link" href="https://myedu.gne.go.kr/myedu/jo/jobshare/selectJobShareView.do?mi=6739" target="_blank" rel="noopener">밀양</a>
        <a class="region-link" href="https://gjedu.gne.go.kr/gjedu/jo/jobshare/selectJobShareView.do?mi=6693" target="_blank" rel="noopener">거제</a>
        <a class="region-link" href="https://ysedu.gne.go.kr/ysedu/jo/jobshare/selectJobShareView.do?mi=6583" target="_blank" rel="noopener">양산</a>
        <a class="region-link" href="https://uredu.gne.go.kr/uredu/jo/jobshare/selectJobShareView.do?mi=6637" target="_blank" rel="noopener">의령</a>
        <a class="region-link" href="https://hmedu.gne.go.kr/hmedu/jo/jobshare/selectJobShareView.do?mi=6628" target="_blank" rel="noopener">함안</a>
        <a class="region-link" href="https://cnedu.gne.go.kr/cnedu/jo/jobshare/selectJobShareView.do?mi=6626" target="_blank" rel="noopener">창녕</a>
        <a class="region-link" href="https://gsedu.gne.go.kr/gsedu/jo/jobshare/selectJobShareView.do?mi=6588" target="_blank" rel="noopener">고성</a>
        <a class="region-link" href="https://nhedu.gne.go.kr/nhedu/jo/jobshare/selectJobShareView.do?mi=6586" target="_blank" rel="noopener">남해</a>
        <a class="region-link" href="https://hdedu.gne.go.kr/hdedu/jo/jobshare/selectJobShareView.do?mi=6572" target="_blank" rel="noopener">하동</a>
        <a class="region-link" href="https://schedu.gne.go.kr/schedu/jo/jobshare/selectJobShareView.do?mi=6566" target="_blank" rel="noopener">산청</a>
        <a class="region-link" href="https://hyedu.gne.go.kr/hyedu/jo/jobshare/selectJobShareView.do?mi=6570" target="_blank" rel="noopener">함양</a>
        <a class="region-link" href="https://gcedu.gne.go.kr/gcedu/jo/jobshare/selectJobShareView.do?mi=6467" target="_blank" rel="noopener">거창</a>
        <a class="region-link" href="https://hcedu.gne.go.kr/hcedu/jo/jobshare/selectJobShareView.do?mi=6568" target="_blank" rel="noopener">합천</a>
      </div>
    </div>
  </div>
  <div class="notice">※ 교육감·부교육감·국장·과장·사무관 등 관리·총괄 직위는 검색 결과에서 제외하고 실무담당자를 우선 안내합니다.<br>※ 이 검색은 경상남도교육청 <b>본청 업무분장</b> 기준입니다. 지역교육지원청 소관 업무는 해당 교육지원청 누리집을 확인해 주세요.</div>
</div>
<script>
const q=document.getElementById('q'), btn=document.getElementById('btn'), status=document.getElementById('status'), results=document.getElementById('results');
const regionToggle=document.getElementById('regionToggle'), regionBox=document.getElementById('regionBox');
function esc(v){return String(v??'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]));}
function tel(v){const m=String(v||'').match(/0\d{1,2}-\d{3,4}-\d{4}/);return m?m[0]:'';}
function setRegion(open){regionBox.style.display=open?'block':'none';regionToggle.textContent=open?'🏫 지역교육청 안내 닫기':'🏫 지역교육청 안내 보기';}
regionToggle.addEventListener('click',()=>setRegion(regionBox.style.display!=='block'));
if(new URLSearchParams(location.search).get('regional')==='1'){setRegion(true);setTimeout(()=>regionBox.scrollIntoView({behavior:'smooth',block:'start'}),100);}
async function search(){
  const query=q.value.trim();
  if(!query){q.focus();return;}
  btn.disabled=true; status.textContent='검색 중입니다…'; results.innerHTML='';
  try{
    const r=await fetch('/api/hq-contact?query='+encodeURIComponent(query),{cache:'no-store'});
    const d=await r.json();
    if(!r.ok||!d.ok) throw new Error(d.message||'검색에 실패했습니다.');
    const list=Array.isArray(d.contacts)?d.contacts:[];
    status.textContent="'"+query+"' 검색 결과 "+list.length+"건";
    if(!list.length){results.innerHTML='<div class="empty">본청 관련 실무담당자를 찾지 못했습니다. 지역교육지원청 소관 업무라면 아래의 <b>지역교육청 안내</b>를 이용해 주세요.</div>';return;}
    results.innerHTML=list.slice(0,5).map(c=>{
      const p=tel(c.phone), phone=p?'<a class="phone" href="tel:'+p.replace(/-/g,'')+'">☎ '+esc(p)+'</a>':'<div class="phone">☎ '+esc(c.phone||'')+'</div>';
      return '<div class="result"><div class="dept">'+esc(c.department||'')+(c.team?' / '+esc(c.team):'')+'</div>'+phone+'<div class="duty">'+esc(c.duty||'')+'</div></div>';
    }).join('');
  }catch(e){status.textContent='';results.innerHTML='<div class="empty">'+esc(e.message||'검색 중 오류가 발생했습니다.')+' 잠시 후 다시 이용해 주세요.</div>';}
  finally{btn.disabled=false;}
}
btn.addEventListener('click',search); q.addEventListener('keydown',e=>{if(e.key==='Enter')search();});
document.querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{q.value=b.dataset.q||'';search();}));
</script>
</body></html>`);
});

// 본청 업무담당자 실시간 조회 테스트용 공개 API
// 예: /api/hq-contact?query=청원
app.get('/api/hq-contact', async (req, res) => {
  const query = String((req.query && req.query.query) || '').trim();
  if (!query) {
    return res.status(400).json({
      ok: false,
      message: '찾으려는 본청 업무명을 입력해 주세요.',
      examples: ['다자녀', '제증명', '고등학교 전입학', '검정고시', '직업교육'],
      officialUrl: GNE_HQ_WORK_SEARCH_URL
    });
  }
  try {
    const contacts = await searchGneHqContacts(query);
    return res.json({ ok: true, query, count: contacts.length, contacts: contacts.slice(0, 10), officialUrl: GNE_HQ_WORK_SEARCH_URL });
  } catch (err) {
    console.error('본청 업무담당자 테스트 API 오류:', err && err.message ? err.message : err);
    return res.status(502).json({ ok: false, message: '경상남도교육청 공식 업무검색 조회에 실패했습니다.', officialUrl: GNE_HQ_WORK_SEARCH_URL });
  }
});

// 전입학 담당자 실시간 조회 테스트용 공개 API
// 예: /api/transfer-contact?query=진주%20중학교%20전학%20담당자
app.get('/api/transfer-contact', async (req, res) => {
  const query = String((req.query && req.query.query) || '').trim();
  const intent = detectTransferContactIntent(query);
  if (!intent) {
    return res.status(400).json({
      ok: false,
      message: '전입학 담당자 질문을 입력해 주세요.',
      examples: ['고등학교 전학 담당자', '진주 중학교 전학 담당자']
    });
  }

  try {
    if (!intent.level) {
      return res.json({ ok: true, needsSchoolLevel: true, region: intent.region || '' });
    }
    if (intent.level === 'high') {
      const contact = await getHighSchoolTransferContact();
      return res.json({ ok: true, contact });
    }
    if (intent.level === 'middle') {
      if (!intent.region) {
        return res.json({ ok: true, needsRegion: true, supportedRegions: GNE_SUPPORT_REGIONS, officialUrl: GNE_EMSCHOOL_URL });
      }
      const contacts = await getMiddleSchoolTransferContacts();
      const contact = contacts.find(x => x.region === intent.region);
      if (!contact) return res.status(404).json({ ok: false, message: '공식 페이지에서 해당 지역 담당자를 찾지 못했습니다.', officialUrl: GNE_EMSCHOOL_URL });
      return res.json({ ok: true, contact });
    }
    return res.json({ ok: true, level: 'elementary', officialUrl: GNE_EMSCHOOL_URL, note: '초등학교 담당자는 중학교 담당자 표와 임의로 연결하지 않습니다.' });
  } catch (err) {
    console.error('전입학 담당자 테스트 API 오류:', err && err.message ? err.message : err);
    return res.status(502).json({ ok: false, message: '공식 홈페이지 실시간 조회에 실패했습니다.' });
  }
});

// ---- 카카오톡 오픈빌더 폴백 스킬 웹훅 ----
// 1) 제목/등록발화와 매우 명확하게 일치하는 짧은 질문 -> 기존 고정답변
// 2) 자연어·복합질문·후속질문 -> 관련 자료 여러 개 검색 -> 생성형 AI가 자료 안에서 답변
// 3) AI 비활성/오류 -> 기존 폴백 + 추천 버튼
app.post('/api/kakao-skill', async (req, res) => {
  const utterance = (req.body && req.body.userRequest && req.body.userRequest.utterance) || '';
  const kakaoUserId = (req.body && req.body.userRequest && req.body.userRequest.user && req.body.userRequest.user.id) || '';
  const blocks = getEffectiveUtterances();

  if (!utterance.trim()) return res.json(withStaffSearchQuickReply(kakaoFallbackResponse('', blocks, { failCount: 0 })));

  // '업무담당자 찾기' 블록에서 @sys.text 파라미터(work)로 받은 검색어는
  // '담당자'라는 단어가 없어도 그대로 본청 업무검색에 사용합니다.
  const hqWorkParam = extractHqWorkParamFromPayload(req.body || {});
  if (hqWorkParam) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, `본청 업무담당자:${hqWorkParam}`, true, 'kakao-live-hq-contact-param', 'kakao:' + kakaoUserId);
    return res.json(withStaffSearchQuickReply(await kakaoHqContactResponse({ query: hqWorkParam })));
  }

  // 전입학 담당자/전화번호 질문은 시나리오 매칭보다 먼저 처리합니다.
  // 경상남도교육청 공식 홈페이지를 실시간 조회하므로 번호를 server.js에 고정하지 않습니다.
  const transferContactIntent = detectTransferContactIntent(utterance);
  if (transferContactIntent) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, '전입학 담당자 실시간 조회', true, 'kakao-live-transfer-contact', 'kakao:' + kakaoUserId);
    return res.json(withStaffSearchQuickReply(await kakaoTransferContactResponse(transferContactIntent)));
  }


  // 그 외 본청 담당자/전화번호 질문은 경남교육청 공식 "업무검색"에서 실시간 조회합니다.
  // 예: 청원 담당자, 정보공개 전화번호, 검정고시 담당자, 학교급식 담당자
  const hqContactIntent = detectHqContactIntent(utterance);
  if (hqContactIntent) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, `본청 업무담당자:${hqContactIntent.query || '업무확인'}`, true, 'kakao-live-hq-contact', 'kakao:' + kakaoUserId);
    return res.json(withStaffSearchQuickReply(await kakaoHqContactResponse(hqContactIntent)));
  }

  // 학교급을 말하지 않은 일반 전학 문의는 억지로 한 블록을 고르지 않고
  // 고등학교/중학교 전입학 두 선택지를 함께 보여줍니다.
  if (needsTransferSchoolLevel(utterance)) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, '전입학 학교급 확인', true, 'kakao-clarify-transfer-level', 'kakao:' + kakaoUserId);
    return res.json(withStaffSearchQuickReply(kakaoTransferSchoolLevelResponse(blocks)));
  }

  // API 유무와 관계없이 먼저 안전한 규칙/대표질문/오타 매칭을 시도
  const match = smartMatch(utterance, blocks);
  if (match.matched && match.idx >= 0) {
    const block = blocks[match.idx];
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, block.title, true, 'kakao-smart-' + match.reason, 'kakao:' + kakaoUserId);

    const outputs = [];
    (block.responses || []).forEach(r => {
      outputs.push({ simpleText: { text: r.message } });
      const urlPhoneButtons = (r.buttons || []).filter(b => b.type === 'url' || b.type === 'phone').map(b => {
        if (b.type === 'url') return { action: 'webLink', label: b.label, webLinkUrl: b.value };
        return { action: 'phone', label: b.label, phoneNumber: b.value };
      });
      if (urlPhoneButtons.length) outputs.push({ basicCard: { title: block.title, description: ' ', buttons: urlPhoneButtons } });
    });

    const quickReplies = buildBlockQuickReplies(block, blocks);
    const assistantSummary = (block.responses || []).map(r => r.message || '').join('\n').slice(0, 1200);
    rememberTurn(kakaoUserId, utterance, assistantSummary);
    return res.json(withStaffSearchQuickReply({ version: '2.0', template: { outputs, quickReplies } }));
  }

  // 확신이 낮으면 1·2등 점수 차이를 보고 폴백. AI가 있을 때만 생성형 보조 사용
  const history = getSession(kakaoUserId);
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const retrievalQuery = utterance.length <= 15 && lastUser ? `${lastUser.content} ${utterance}` : utterance;
  const candidates = aiCandidateBlocks(retrievalQuery, blocks, 6);
  const bestCandidate = (match.candidates || [])[0];

  if (!AI_ENABLED) {
    const failCount = markKakaoFailure(kakaoUserId);
    const transferContext = getTransferFailureContext(utterance, blocks, bestCandidate);
    let transferFail = { count: 0, highSchool: false };
    if (transferContext.isTransfer) {
      transferFail = markKakaoTransferFailure(kakaoUserId, transferContext.highSchool);
    } else {
      resetKakaoTransferFailStreak(kakaoUserId);
    }
    logMissed(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', bestCandidate ? bestCandidate.score : 0);
    trackQuery(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', false, 'kakao-no-ai-ambiguous', 'kakao:' + kakaoUserId);
    return res.json(withStaffSearchQuickReply(kakaoFallbackResponse(utterance, blocks, {
      failCount,
      transferFailCount: transferFail.count,
      showTransferAi: transferFail.highSchool
    })));
  }

  try {
    const answer = await askClaudeGrounded({ utterance, kakaoUserId, candidates, blocks });
    const candidateTitle = candidates.length ? blocks[candidates[0].idx].title : '';
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, candidateTitle ? `AI:${candidateTitle}` : 'AI', true, 'kakao-ai', 'kakao:' + kakaoUserId);
    rememberTurn(kakaoUserId, utterance, answer);
    return res.json(withStaffSearchQuickReply(kakaoAiResponse(answer, candidates, blocks)));
  } catch (err) {
    console.error('카카오 AI 응답 오류:', err && err.message ? err.message : err);
    const failCount = markKakaoFailure(kakaoUserId);
    const transferContext = getTransferFailureContext(utterance, blocks, bestCandidate);
    let transferFail = { count: 0, highSchool: false };
    if (transferContext.isTransfer) {
      transferFail = markKakaoTransferFailure(kakaoUserId, transferContext.highSchool);
    } else {
      resetKakaoTransferFailStreak(kakaoUserId);
    }
    logMissed(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', bestCandidate ? bestCandidate.score : 0);
    trackQuery(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', false, 'kakao-ai-error', 'kakao:' + kakaoUserId);
    return res.json(withStaffSearchQuickReply(kakaoFallbackResponse(utterance, blocks, {
      failCount,
      transferFailCount: transferFail.count,
      showTransferAi: transferFail.highSchool
    })));
  }
});

// ============ 관리자 API (x-admin-token 헤더 필요) ============

app.get('/api/admin/missed', requireAdmin, (req, res) => {
  res.json(readJson(MISSED_PATH, []));
});
app.delete('/api/admin/missed', requireAdmin, (req, res) => {
  writeJson(MISSED_PATH, []);
  res.json({ status: 'ok' });
});
app.delete('/api/admin/missed/:i', requireAdmin, (req, res) => {
  const list = readJson(MISSED_PATH, []);
  const i = Number(req.params.i);
  if (i>=0 && i<list.length) list.splice(i,1);
  writeJson(MISSED_PATH, list);
  res.json({ status: 'ok' });
});

// 놓친 질문을 같은 뜻끼리 묶어 빈도순으로 반환 (가장 자주 놓친 질문부터 학습하도록)
app.get('/api/admin/missed-summary', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  const summary = getMissedSummary();
  res.json({
    total: summary.length,
    totalOccurrences: summary.reduce((s, g) => s + g.count, 0),
    items: summary.slice(0, limit)
  });
});

// 학습 등록 후 해당 그룹(같은 뜻으로 묶인 질문들)을 놓친 목록에서 한 번에 정리
app.delete('/api/admin/missed-summary/:key', requireAdmin, (req, res) => {
  const key = req.params.key;
  const list = readJson(MISSED_PATH, []);
  const filtered = list.filter(e => normalizeMissedKey(e.query) !== key);
  writeJson(MISSED_PATH, filtered);
  res.json({ status: 'ok', removed: list.length - filtered.length });
});

app.get('/api/admin/missed.csv', requireAdmin, (req, res) => {
  const summary = getMissedSummary();
  const csv = toCsv(summary, [
    { key: 'sample', label: '질문' },
    { key: 'count', label: '횟수' },
    { key: 'bestGuessTitle', label: '추정 항목' },
    { key: 'bestGuessScore', label: '추정 점수' },
    { key: 'alreadyLearned', label: '학습됨' },
    { key: 'firstSeen', label: '최초발생' },
    { key: 'lastSeen', label: '최근발생' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="missed-summary.csv"');
  res.send(csv);
});

// 사용 통계: 인기 질문, 일별 추이, 매칭 성공률, 순방문자
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  const total = list.length;
  const matchedCount = list.filter(e => e.matched).length;

  const byTitle = {};
  list.forEach(e => { if (e.matched && e.matchedTitle) byTitle[e.matchedTitle] = (byTitle[e.matchedTitle]||0)+1; });
  const topBlocks = Object.entries(byTitle).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([title,count])=>({title,count}));

  const byDayCount = {};
  const byDayVisitors = {}; // date -> Set(visitorId)
  list.forEach(e => {
    const d = (e.time||'').slice(0,10);
    if (!d) return;
    byDayCount[d] = (byDayCount[d]||0)+1;
    if (e.visitorId) {
      if (!byDayVisitors[d]) byDayVisitors[d] = new Set();
      byDayVisitors[d].add(e.visitorId);
    }
  });
  const days = Object.keys(byDayCount).sort().slice(-14).map(d => ({
    date: d, count: byDayCount[d], uniqueVisitors: byDayVisitors[d] ? byDayVisitors[d].size : 0
  }));

  const bySource = {};
  list.forEach(e => { const s = e.source||'unknown'; bySource[s] = (bySource[s]||0)+1; });

  const allVisitorIds = new Set(list.map(e => e.visitorId).filter(Boolean));
  const visitorQueryCounts = {};
  list.forEach(e => { if (e.visitorId) visitorQueryCounts[e.visitorId] = (visitorQueryCounts[e.visitorId]||0)+1; });
  const avgQueriesPerVisitor = allVisitorIds.size ? Number((total/allVisitorIds.size).toFixed(1)) : 0;

  res.json({
    total, matchedCount, unmatchedCount: total - matchedCount,
    matchRate: total ? Number((matchedCount/total*100).toFixed(1)) : 0,
    uniqueVisitors: allVisitorIds.size, avgQueriesPerVisitor,
    topBlocks, days, bySource
  });
});
app.delete('/api/admin/stats', requireAdmin, (req, res) => {
  writeJson(QUERIES_PATH, []);
  res.json({ status: 'ok' });
});

app.get('/api/admin/stats/top.csv', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  const byTitle = {};
  list.forEach(e => { if (e.matched && e.matchedTitle) byTitle[e.matchedTitle] = (byTitle[e.matchedTitle]||0)+1; });
  const rows = Object.entries(byTitle).sort((a,b)=>b[1]-a[1]).map(([title,count])=>({title,count}));
  const csv = toCsv(rows, [{ key: 'title', label: '항목' }, { key: 'count', label: '건수' }]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="top-questions.csv"');
  res.send(csv);
});

// 시나리오 블록 idx/제목 목록 (관리자 대시보드에서 '학습 등록' 시 드롭다운으로 사용)
app.get('/api/admin/blocks', requireAdmin, (req, res) => {
  res.json(BLOCKS.map((b, idx) => ({ idx, title: b.title })));
});

app.post('/api/learn', requireAdmin, (req, res) => {
  const { text, blockTitle } = req.body || {};
  let { blockIdx } = req.body || {};
  if (blockIdx == null && blockTitle) {
    const found = BLOCKS.findIndex(b => b.title === blockTitle);
    if (found >= 0) blockIdx = found;
  }
  if (!text || blockIdx == null || !BLOCKS[blockIdx]) {
    return res.status(400).json({ error: 'text와 유효한 blockIdx(또는 blockTitle)가 필요합니다.' });
  }
  const list = readJson(LEARNED_PATH, []);
  if (!list.some(e => e.text === text && e.blockIdx === blockIdx)) {
    list.push({ text, blockIdx, blockTitle: BLOCKS[blockIdx].title, time: new Date().toISOString() });
    writeJson(LEARNED_PATH, list);
  }
  res.json({ status: 'ok', list });
});
app.delete('/api/learn/:i', requireAdmin, (req, res) => {
  const list = readJson(LEARNED_PATH, []);
  const i = Number(req.params.i);
  if (i>=0 && i<list.length) list.splice(i,1);
  writeJson(LEARNED_PATH, list);
  res.json({ status: 'ok' });
});

// 관리자 대시보드: 통계 / 놓친 질문(빈도순) / 학습 표현 관리를 한 화면에서
app.get('/admin', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>경상남도교육청 민원 챗봇 관리자</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;color:#222}
  .wrap{max-width:960px;margin:0 auto;padding:18px 14px 60px}
  h1{font-size:20px;margin:0 0 14px}
  .card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:16px}
  .card h2{font-size:16px;margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  input,select,button{font-size:14px;font-family:inherit}
  input[type=password],input[type=text]{height:42px;border:1px solid #cfd6dd;border-radius:9px;padding:0 12px;outline:none}
  button{height:42px;border:0;border-radius:9px;padding:0 15px;font-weight:700;background:#fee500;color:#191919;cursor:pointer}
  button.ghost{background:#eef2f6;color:#333}
  button.danger{background:#fde8e8;color:#b02a2a}
  .summary4{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  @media(min-width:600px){.summary4{grid-template-columns:repeat(4,1fr)}}
  .stat{background:#f7f9fb;border-radius:12px;padding:12px}
  .stat .n{font-size:22px;font-weight:800}.stat .l{font-size:12px;color:#777;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eef1f4;vertical-align:top}
  th{color:#777;font-weight:700}
  .muted{color:#999}.small{font-size:12px}
  .badge{display:inline-block;background:#e8f3ff;color:#1b5dbf;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700}
  .badge.ok{background:#e9f8ee;color:#1c8a45}
  .gap{margin-top:10px}
  #gate{max-width:360px;margin:60px auto}
  a.dl{font-size:12px;color:#1b5dbf;text-decoration:none;font-weight:700}
</style>
</head>
<body>
<div class="wrap">
  <div id="gate" class="card">
    <h1>관리자 로그인</h1>
    <div class="row">
      <input id="token" type="password" placeholder="관리자 토큰(ADMIN_TOKEN)" style="flex:1">
      <button id="loginBtn">확인</button>
    </div>
    <div id="loginMsg" class="small muted gap"></div>
  </div>

  <div id="dash" style="display:none">
    <h1>경상남도교육청 민원 챗봇 관리자 대시보드 <button class="ghost" id="logoutBtn" style="height:32px;padding:0 10px;font-size:12px">로그아웃</button></h1>

    <div class="card">
      <h2>전체 통계 <button class="ghost" id="refreshBtn" style="height:32px;padding:0 10px;font-size:12px">새로고침</button></h2>
      <div class="summary4" id="summary4"></div>
      <div class="gap small muted" id="statsMeta"></div>
      <div class="gap"><b class="small">인기 질문 TOP</b> <a class="dl" id="topCsv" href="#">CSV 다운로드</a></div>
      <table id="topTable"><thead><tr><th>항목</th><th>건수</th></tr></thead><tbody></tbody></table>
    </div>

    <div class="card">
      <h2>놓친 질문 (빈도순) <a class="dl" id="missedCsv" href="#">CSV 다운로드</a></h2>
      <div class="small muted">같은 뜻으로 보이는 질문은 하나로 묶어서 보여줘요. 자주 놓친 질문부터 학습시키는 걸 추천해요.</div>
      <table id="missedTable"><thead><tr><th>질문</th><th>횟수</th><th>추정 항목</th><th>학습 등록</th></tr></thead><tbody></tbody></table>
    </div>

    <div class="card">
      <h2>학습된 표현</h2>
      <table id="learnedTable"><thead><tr><th>등록한 문장</th><th>연결된 항목</th><th></th></tr></thead><tbody></tbody></table>
    </div>
  </div>
</div>
<script>
function esc(v){return String(v??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
let TOKEN = sessionStorage.getItem('adminToken') || '';
let BLOCKS = [];

async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({'x-admin-token': TOKEN, 'Content-Type':'application/json'}, opts.headers||{});
  const r = await fetch(path, opts);
  if (r.status === 401) { logout('토큰이 올바르지 않아요.'); throw new Error('unauthorized'); }
  return r.json();
}

function logout(msg){
  TOKEN=''; sessionStorage.removeItem('adminToken');
  document.getElementById('dash').style.display='none';
  document.getElementById('gate').style.display='block';
  document.getElementById('loginMsg').textContent = msg || '';
}

async function login(){
  const t = document.getElementById('token').value.trim();
  if (!t) return;
  TOKEN = t;
  try {
    await api('/api/admin/blocks');
    sessionStorage.setItem('adminToken', TOKEN);
    document.getElementById('gate').style.display='none';
    document.getElementById('dash').style.display='block';
    loadAll();
  } catch(e) {
    document.getElementById('loginMsg').textContent = '토큰이 올바르지 않아요. 다시 확인해 주세요.';
  }
}

async function loadAll(){
  document.getElementById('topCsv').href = '/api/admin/stats/top.csv?token=' + encodeURIComponent(TOKEN);
  document.getElementById('missedCsv').href = '/api/admin/missed.csv?token=' + encodeURIComponent(TOKEN);
  BLOCKS = await api('/api/admin/blocks');
  await Promise.all([loadStats(), loadMissed(), loadLearned()]);
}

async function loadStats(){
  const s = await api('/api/admin/stats');
  document.getElementById('summary4').innerHTML = [
    ['전체 질문', s.total],
    ['매칭률', s.matchRate + '%'],
    ['순방문자', s.uniqueVisitors],
    ['1인당 평균 질문', s.avgQueriesPerVisitor]
  ].map(([l,n])=>'<div class="stat"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>').join('');
  document.getElementById('statsMeta').textContent = '매칭 ' + s.matchedCount + '건 / 미매칭 ' + s.unmatchedCount + '건';
  document.querySelector('#topTable tbody').innerHTML = (s.topBlocks||[]).map(b=>
    '<tr><td>'+esc(b.title)+'</td><td>'+esc(b.count)+'</td></tr>'
  ).join('') || '<tr><td colspan="2" class="muted">데이터가 없어요.</td></tr>';
}

async function loadMissed(){
  const d = await api('/api/admin/missed-summary?limit=100');
  const options = '<option value="">항목 선택…</option>' + BLOCKS.map(b=>'<option value="'+b.idx+'">'+esc(b.title)+'</option>').join('');
  document.querySelector('#missedTable tbody').innerHTML = (d.items||[]).map(g=>{
    const learnedBadge = g.alreadyLearned ? ' <span class="badge ok">학습됨</span>' : '';
    return '<tr>'+
      '<td>'+esc(g.sample)+learnedBadge+'</td>'+
      '<td>'+esc(g.count)+'</td>'+
      '<td class="small muted">'+esc(g.bestGuessTitle||'-')+'</td>'+
      '<td><div class="row">'+
        '<select data-key="'+esc(g.key)+'" data-text="'+esc(g.sample)+'" class="teachSelect">'+options+'</select>'+
        '<button class="ghost teachBtn" style="height:36px;padding:0 10px;font-size:12px" data-key="'+esc(g.key)+'" data-text="'+esc(g.sample)+'">학습</button>'+
      '</div></td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="4" class="muted">놓친 질문이 없어요.</td></tr>';

  document.querySelectorAll('.teachBtn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const sel = document.querySelector('select[data-key="'+btn.dataset.key+'"]');
      const blockIdx = sel.value;
      if (!blockIdx) { sel.focus(); return; }
      btn.disabled = true;
      try{
        await api('/api/learn', { method:'POST', body: JSON.stringify({ text: btn.dataset.text, blockIdx: Number(blockIdx) }) });
        await api('/api/admin/missed-summary/'+encodeURIComponent(btn.dataset.key), { method:'DELETE' });
        await Promise.all([loadMissed(), loadLearned()]);
      } finally { btn.disabled = false; }
    });
  });
}

async function loadLearned(){
  const list = await api('/api/learned');
  document.querySelector('#learnedTable tbody').innerHTML = (list||[]).map((e,i)=>
    '<tr><td>'+esc(e.text)+'</td><td class="small muted">'+esc(e.blockTitle || (BLOCKS[e.blockIdx]||{}).title || ('#'+e.blockIdx))+'</td>'+
    '<td><button class="danger delLearn" style="height:32px;padding:0 10px;font-size:12px" data-i="'+i+'">삭제</button></td></tr>'
  ).join('') || '<tr><td colspan="3" class="muted">등록된 학습 표현이 없어요.</td></tr>';

  document.querySelectorAll('.delLearn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      btn.disabled = true;
      try { await api('/api/learn/'+btn.dataset.i, { method:'DELETE' }); await loadLearned(); }
      finally { btn.disabled = false; }
    });
  });
}

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('token').addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });
document.getElementById('logoutBtn').addEventListener('click', ()=>logout(''));
document.getElementById('refreshBtn').addEventListener('click', loadAll);

if (TOKEN) { document.getElementById('token').value=''; login(); }
</script>
</body></html>`);
});

app.get('/', (req, res) => {
  res.send('경상남도교육청 민원 챗봇 백엔드가 정상적으로 실행 중입니다.');
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (ADMIN_TOKEN === 'change-me') {
    console.log('⚠ ADMIN_TOKEN 환경변수를 설정하지 않으면 기본값(change-me)이 사용됩니다. 꼭 바꿔주세요.');
  }

  // 카카오 요청이 들어온 뒤 홈페이지 전체(수백 건)를 읽기 시작하면 5초 제한에 걸릴 수 있어
  // 서버가 뜨자마자 공식 업무분장 정보를 미리 캐시합니다.
  setTimeout(() => {
    refreshGneHqContacts(10000).catch(err => {
      console.error('본청 업무담당자 시작 캐시 오류:', err && err.message ? err.message : err);
    });
  }, 300);

  // 실행 중에는 20분마다 백그라운드에서 최신 공식 업무분장으로 갱신합니다.
  const hqRefreshTimer = setInterval(() => {
    refreshGneHqContacts(10000).catch(err => {
      console.error('본청 업무담당자 정기 캐시 오류:', err && err.message ? err.message : err);
    });
  }, 20 * 60 * 1000);
  if (hqRefreshTimer.unref) hqRefreshTimer.unref();
});
