// 경남교육청 민원 챗봇 백엔드 서버
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
const FAIL_STREAK_TTL_MS = 30 * 60 * 1000;
const FAIL_STREAK_ESCALATE_AT = 2;

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
  const escalated = failCount >= FAIL_STREAK_ESCALATE_AT;
  const cands = topCandidates(utterance, blocks, 3);
  const quickReplies = [];

  // 두 번 이상 연속으로 못 알아들었을 때는 1:1 채팅상담을 가장 먼저 보여줍니다.
  if (escalated) {
    const chatBlock = blocks.find(b => (b.title || '').trim() === '일대일 채팅 상담 안내');
    if (chatBlock) {
      const chatReply = makeKakaoQuickReply(chatBlock);
      chatReply.label = '💬 1:1 채팅상담';
      quickReplies.push(chatReply);
    }
  }

  cands
    .map(c => makeKakaoQuickReply(blocks[c.idx]))
    .filter(q => q.label)
    .forEach(q => quickReplies.push(q));

  quickReplies.push({ label: '☎ 콜센터 연결', action: 'message', messageText: '콜센터' });

  const text = escalated
    ? '질문을 계속 정확히 확인하기 어려워요.\n아래 1:1 채팅상담을 이용하시거나, 관련 항목을 선택해주세요.'
    : '제가 질문을 정확히 확인하기 어려워요.\n조금 더 구체적으로 말씀해주시거나 아래 항목 중에서 골라주세요.';

  // 혹시 같은 항목이 중복으로 들어온 경우 제거
  const seen = new Set();
  const deduped = quickReplies.filter(q => {
    const key = `${q.label}|${q.blockId || q.messageText || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text } }],
      quickReplies: deduped.slice(0, 10)
    }
  };
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
  const given = (req.header('x-admin-token') || '').trim();
  if (given !== ADMIN_TOKEN.trim()) {
    return res.status(401).json({ error: '관리자 토큰이 올바르지 않습니다.' });
  }
  next();
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

// ---- 카카오톡 오픈빌더 폴백 스킬 웹훅 ----
// 1) 제목/등록발화와 매우 명확하게 일치하는 짧은 질문 -> 기존 고정답변
// 2) 자연어·복합질문·후속질문 -> 관련 자료 여러 개 검색 -> 생성형 AI가 자료 안에서 답변
// 3) AI 비활성/오류 -> 기존 폴백 + 추천 버튼
app.post('/api/kakao-skill', async (req, res) => {
  const utterance = (req.body && req.body.userRequest && req.body.userRequest.utterance) || '';
  const kakaoUserId = (req.body && req.body.userRequest && req.body.userRequest.user && req.body.userRequest.user.id) || '';
  const blocks = getEffectiveUtterances();

  if (!utterance.trim()) return res.json(kakaoFallbackResponse('', blocks, { failCount: 0 }));

  // API 유무와 관계없이 먼저 안전한 규칙/대표질문/오타 매칭을 시도
  const match = smartMatch(utterance, blocks);
  if (match.matched && match.idx >= 0) {
    const block = blocks[match.idx];
    resetKakaoFailStreak(kakaoUserId);
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
    return res.json({ version: '2.0', template: { outputs, quickReplies } });
  }

  // 확신이 낮으면 1·2등 점수 차이를 보고 폴백. AI가 있을 때만 생성형 보조 사용
  const history = getSession(kakaoUserId);
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const retrievalQuery = utterance.length <= 15 && lastUser ? `${lastUser.content} ${utterance}` : utterance;
  const candidates = aiCandidateBlocks(retrievalQuery, blocks, 6);
  const bestCandidate = (match.candidates || [])[0];

  if (!AI_ENABLED) {
    const failCount = markKakaoFailure(kakaoUserId);
    logMissed(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', bestCandidate ? bestCandidate.score : 0);
    trackQuery(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', false, 'kakao-no-ai-ambiguous', 'kakao:' + kakaoUserId);
    return res.json(kakaoFallbackResponse(utterance, blocks, { failCount }));
  }

  try {
    const answer = await askClaudeGrounded({ utterance, kakaoUserId, candidates, blocks });
    const candidateTitle = candidates.length ? blocks[candidates[0].idx].title : '';
    resetKakaoFailStreak(kakaoUserId);
    trackQuery(utterance, candidateTitle ? `AI:${candidateTitle}` : 'AI', true, 'kakao-ai', 'kakao:' + kakaoUserId);
    rememberTurn(kakaoUserId, utterance, answer);
    return res.json(kakaoAiResponse(answer, candidates, blocks));
  } catch (err) {
    console.error('카카오 AI 응답 오류:', err && err.message ? err.message : err);
    const failCount = markKakaoFailure(kakaoUserId);
    logMissed(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', bestCandidate ? bestCandidate.score : 0);
    trackQuery(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', false, 'kakao-ai-error', 'kakao:' + kakaoUserId);
    return res.json(kakaoFallbackResponse(utterance, blocks, { failCount }));
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

app.post('/api/learn', requireAdmin, (req, res) => {
  const { text, blockIdx } = req.body || {};
  if (!text || blockIdx == null || !BLOCKS[blockIdx]) {
    return res.status(400).json({ error: 'text와 유효한 blockIdx가 필요합니다.' });
  }
  const list = readJson(LEARNED_PATH, []);
  if (!list.some(e => e.text === text && e.blockIdx === blockIdx)) {
    list.push({ text, blockIdx, time: new Date().toISOString() });
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

app.get('/', (req, res) => {
  res.send('경남교육청 1004챗봇 백엔드가 정상적으로 실행 중입니다.');
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (ADMIN_TOKEN === 'change-me') {
    console.log('⚠ ADMIN_TOKEN 환경변수를 설정하지 않으면 기본값(change-me)이 사용됩니다. 꼭 바꿔주세요.');
  }
});
