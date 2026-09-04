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
const XLSX = require('xlsx');
const crypto = require('crypto');

const app = express();
app.use(cors());               // 필요하면 특정 도메인만 허용하도록 좁힐 수 있음 (README 참고)
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://gnechatbot-backend.onrender.com').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';

// Render Free 안정화 옵션
// - Free 인스턴스는 유휴 상태에서 잠들 수 있으므로, 필요할 때만 환경변수로 keep-warm을 켤 수 있습니다.
// - KEEP_WARM_ENABLED=true 로 설정하면 약 12분마다 공개 health URL을 가볍게 호출합니다.
// - Render가 보장하는 기능은 아니며, 무료 인스턴스 시간/트래픽 한도는 별도로 적용됩니다.
const KEEP_WARM_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.KEEP_WARM_ENABLED || '').trim());
const KEEP_WARM_INTERVAL_MS = Math.max(
  8 * 60 * 1000,
  Number(process.env.KEEP_WARM_INTERVAL_MS || 12 * 60 * 1000) || 12 * 60 * 1000
);

const DATA_DIR = path.join(__dirname, 'data');
const SCENARIOS_PATH = path.join(DATA_DIR, 'scenarios.json');
const LEARNED_PATH = path.join(DATA_DIR, 'learned.json');
const MISSED_PATH = path.join(DATA_DIR, 'missed.json');
const QUERIES_PATH = path.join(DATA_DIR, 'queries.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch (e) { return fallback; }
}
function writeJsonLocal(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 1), 'utf-8');
}

// ============ Supabase 영구저장 (Render 재배포/재시작 시 통계 보존) ============
// 설정이 없거나 Supabase가 일시 실패하면 로컬 JSON 방식으로 계속 동작합니다.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_SECRET_KEY);
const SUPABASE_TABLE = 'chatbot_store';
const PERSIST_PATH_KEYS = new Map([
  [LEARNED_PATH, 'learned'],
  [MISSED_PATH, 'missed'],
  [QUERIES_PATH, 'queries']
]);
const PERSIST_QUEUES = new Map();

function persistentKeyForPath(p) {
  return PERSIST_PATH_KEYS.get(p) || '';
}
function hashVisitorId(value) {
  if (!value) return '';
  // 이미 비식별화된 값이면 재해시하지 않습니다.
  if (/^v_[a-f0-9]{32}$/i.test(String(value))) return String(value);
  return 'v_' + crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}
function sanitizeForRemote(key, data) {
  if (key !== 'queries' || !Array.isArray(data)) return data;
  return data.map(row => ({
    ...row,
    visitorId: row && row.visitorId ? hashVisitorId(row.visitorId) : ''
  }));
}
function supabaseHeaders(extra = {}) {
  // sb_secret_* 키는 JWT가 아니므로 Authorization Bearer가 아니라 apikey 헤더로 보냅니다.
  return { apikey: SUPABASE_SECRET_KEY, ...extra };
}
async function supabaseFetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Supabase HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}
async function loadSupabaseStore() {
  if (!SUPABASE_ENABLED) return new Map();
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?select=key,data,updated_at&key=in.(queries,missed,learned)`;
  const rows = await supabaseFetchJson(url, { headers: supabaseHeaders() });
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.key, row.data]));
}
async function saveSupabaseStore(key, data) {
  if (!SUPABASE_ENABLED || !key) return;
  const payload = [{ key, data: sanitizeForRemote(key, data), updated_at: new Date().toISOString() }];
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=key`;
  await supabaseFetchJson(url, {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify(payload)
  });
}
async function saveSupabaseStoreWithRetry(key, data) {
  let lastErr = null;
  for (const delay of [0, 800, 2200]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { return await saveSupabaseStore(key, data); }
    catch (err) { lastErr = err; }
  }
  throw lastErr;
}
function queueSupabasePersist(p, data) {
  const key = persistentKeyForPath(p);
  if (!SUPABASE_ENABLED || !key) return;
  const previous = PERSIST_QUEUES.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => saveSupabaseStoreWithRetry(key, data))
    .catch(err => console.error(`Supabase ${key} 저장 실패:`, err && err.message ? err.message : err));
  PERSIST_QUEUES.set(key, next);
}
function writeJson(p, data) {
  writeJsonLocal(p, data);
  queueSupabasePersist(p, data);
}
async function initSupabasePersistence() {
  if (!SUPABASE_ENABLED) {
    console.log('ℹ Supabase 영구저장 비활성화: SUPABASE_URL / SUPABASE_SECRET_KEY 확인');
    return;
  }
  try {
    const remote = await loadSupabaseStore();
    for (const [p, key] of PERSIST_PATH_KEYS.entries()) {
      if (remote.has(key) && Array.isArray(remote.get(key))) {
        writeJsonLocal(p, remote.get(key));
      } else {
        // 최초 연결 시 현재 로컬 데이터를 원격 저장소의 시작값으로 등록합니다.
        await saveSupabaseStoreWithRetry(key, readJson(p, []));
      }
    }
    console.log('✅ Supabase 영구저장 연결 완료: chatbot_store (통계/놓친질문/학습표현 복구)');
  } catch (err) {
    // DB 장애가 챗봇 자체 장애로 번지지 않도록 로컬 방식으로 계속 실행합니다.
    console.error('Supabase 초기 연결 실패 - 로컬 저장으로 계속 실행:', err && err.message ? err.message : err);
  }
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
  '학폭':'학교폭력', '스승찾기':'선생님찾기', '은사찾기':'선생님찾기',
  // 교원·학교 현장에서 자주 쓰는 명칭 차이도 같은 의미로 연결합니다.
  '기간제교원':'계약제교원', '기간제교사':'계약제교원', '계약제교사':'계약제교원', '기간제선생님':'계약제교원',
  '체험학습':'현장체험학습', '현장학습':'현장체험학습', '학교현장체험학습':'현장체험학습',
  '공무직':'교육공무직원', '늘봄':'늘봄학교',
  '교권보호':'교육활동보호', '교권침해':'교육활동침해'
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


// 본청 업무담당자 검색용 동의어 그룹입니다.
// 시나리오 제목을 강제로 바꾸는 것이 아니라, 공식 업무분장에 실제로 쓰이는 여러 표현을 함께 조회합니다.
const HQ_CONTACT_ALIAS_GROUPS = Object.freeze([
  {
    canonical: '계약제교원',
    aliases: ['계약제교원', '기간제교원', '기간제교사', '계약제교사', '기간제선생님']
  },
  {
    canonical: '유아특수교육과 유치원 교사 인사',
    aliases: [
      '유아특수교육과 유치원 교사 인사',
      '유치원 교원 인사', '유치원교원 인사',
      '유치원 교사 인사', '유치원교사 인사',
      '유치원 선생님 인사', '유치원선생님 인사'
    ]
  },
  {
    canonical: '특수교원 인사',
    aliases: ['특수교원 인사', '특수교사 인사', '특수선생님 인사']
  },
  {
    canonical: '현장체험학습',
    aliases: ['현장체험학습', '체험학습', '현장학습', '학교현장체험학습']
  },
  {
    canonical: '교원 인사',
    aliases: [
      '교원 인사', '교사 인사', '선생님 인사', '교감 인사', '교장 인사',
      '장학관 인사', '교육연구관 인사', '교육전문직원 인사', '전문직 인사',
      '장학사 인사', '교육연구사 인사'
    ]
  },
  { canonical: '학교폭력', aliases: ['학교폭력', '학폭'] },
  { canonical: '교육활동보호', aliases: ['교육활동보호', '교권보호'] },
  { canonical: '교육활동침해', aliases: ['교육활동침해', '교권침해'] },
  { canonical: '교육공무직원', aliases: ['교육공무직원', '교육공무직', '공무직'] },
  { canonical: '늘봄학교', aliases: ['늘봄학교', '늘봄'] },
  { canonical: '검정고시', aliases: ['검정고시', '검고'] },
  { canonical: '정보공개청구', aliases: ['정보공개청구', '정보공개'] },
  { canonical: '국민신문고', aliases: ['국민신문고', '신문고'] }
]);

function getHqContactAliasGroup(query) {
  const compact = compactText(String(query || ''));
  if (!compact) return null;
  return HQ_CONTACT_ALIAS_GROUPS.find(group =>
    group.aliases.some(alias => compactText(alias) === compact)
  ) || null;
}

function hqContactSearchVariants(query) {
  const raw = String(query || '').trim().replace(/\s+/g, ' ');
  if (!raw) return [];
  const group = getHqContactAliasGroup(raw);
  if (!group) return [raw];
  const values = [group.canonical, ...group.aliases];
  const seen = new Set();
  return values.filter(value => {
    const key = compactText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeHqContactRows(rowGroups, maxResults = 0) {
  const out = [];
  const seen = new Set();
  for (const rows of rowGroups) {
    for (const row of (rows || [])) {
      const key = `${row.department || ''}|${row.team || ''}|${row.phone || ''}|${row.duty || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (maxResults && out.length >= maxResults) return out;
    }
  }
  return out;
}

function rankHqContactRowsWithAliases(query, rows, maxResults = 10) {
  const variants = hqContactSearchVariants(query);
  if (variants.length <= 1) return rankHqContactRows(query, rows, maxResults);
  // 각 동의어를 공식 업무분장에 별도로 대조한 뒤 중복 담당자를 하나로 합칩니다.
  // 웹 검색은 maxResults=0이라 전체 관련 담당자를 확인할 수 있습니다.
  const groups = variants.map(variant => rankHqContactRows(variant, rows, 0));
  return mergeHqContactRows(groups, maxResults);
}

function normalizeHqContactSearchQuery(rawQuery) {
  let q = String(rawQuery || '').trim().replace(/\s+/g, ' ');
  if (!q) return '';

  // 민원인이 자주 붙이는 표현 때문에 공식 업무분장 검색어가 지나치게 좁아지지 않도록
  // 의미가 명확한 경우에만 대표 검색어로 정규화합니다.
  // 예) '다자녀 지원 담당자' → '다자녀'
  const compact = compactText(q);
  if (/^다자녀(?:지원|지원금|입학지원|입학지원금|교육비지원)?$/.test(compact)) return '다자녀';

  // 인사 업무는 시나리오의 '부패·공익신고' 같은 다른 항목으로 유사매칭되지 않도록
  // 공식 업무분장에서 쓰는 표현으로 정규화합니다.
  // 띄어쓰기 여부와 관계없이 동일하게 처리합니다.
  if (/^(?:지방)?공무원인사$/.test(compact)) return '지방공무원 인사';
  if (/^교원인사$/.test(compact)) return '교원 인사';

  // 유치원 교원 인사는 유아특수교육과의 유아장학·인사 업무를 우선 찾습니다.
  if (/^(유치원교원인사|유치원교사인사|유치원선생님인사)$/.test(compact)) {
    return '유아특수교육과 유치원 교사 인사';
  }

  // 특수교원 인사는 학교급에 따라 담당부서가 달라지므로 학교급이 특정되면 해당 과를 함께 검색합니다.
  if (/^(유치원특수교원인사|유치원특수교사인사|특수유치원교사인사)$/.test(compact)) {
    return '유아특수교육과 유치원 특수교사 인사';
  }
  if (/^(초등특수교원인사|초등특수교사인사)$/.test(compact)) {
    return '초등교육과 초등특수 교원 인사';
  }
  if (/^(중등특수교원인사|중등특수교사인사)$/.test(compact)) {
    return '중등교육과 중등특수 교원 인사';
  }

  // 기간제/계약제 교원, 현장체험학습 등은 같은 업무를 서로 다른 명칭으로 부르는 경우가 많습니다.
  const aliasGroup = getHqContactAliasGroup(q);
  if (aliasGroup) return aliasGroup.canonical;

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

// '업무담당자' 메뉴와 같은 화면을 열어야 하는 대표 표현들입니다.
// 검색어 없이 이 표현만 들어오면 담당자를 억지로 검색하지 않고
// 본청 업무검색 / 지역교육청 안내 버튼이 있는 안내 카드를 보여줍니다.
function isHqContactMenuAlias(rawQuery) {
  const q = compactText(String(rawQuery || ''));
  if (!q) return false;

  // 특정 업무명이 붙은 질문(예: '제증명 담당자')은 실제 담당자 검색으로 보내고,
  // '담당자(본청) 안내', '담당자 안내', '담당부서', '담당업무'처럼
  // 담당자 메뉴 자체를 뜻하는 표현만 안내 카드로 보냅니다.
  const hasContactWord = /(업무담당자|업무담당|담당업무|담당부서|담당과|담당자|담당)/.test(q);
  if (!hasContactWord) return false;

  const residue = q
    .replace(/경상남도교육청|경남교육청|교육청|본청/g, '')
    .replace(/업무담당자|업무담당|담당업무|담당부서|담당과|담당자|담당/g, '')
    .replace(/안내|찾기|검색|조회|메뉴|바로가기|전화번호|연락처|문의처|전화|연락|문의/g, '')
    .replace(/알려줘|알려주세요|보여줘|보여주세요|어디야|어디예요|어디에요|어디/g, '')
    .replace(/[^가-힣a-z0-9]/gi, '');

  return residue.length === 0;
}

function hqContactQueryCore(rawQuery) {
  let q = String(rawQuery || '').trim();
  q = q
    .replace(/경상남도교육청|경남교육청|교육청\s*본청|본청/gi, ' ')
    .replace(/업무\s*담당자|업무\s*담당|담당\s*공무원|담당업무|담당자|담당부서|담당과|담당|문의처|연락처|전화번호|전화\s*번호|전화|연락/gi, ' ')
    .replace(/누구(?:한테|에게)?|어디(?:로|에)?\s*(?:문의|전화)?|문의(?:하고\s*싶어|하려면|해야\s*해|해요|할까요)?/gi, ' ')
    .replace(/알려\s*줘|알려주세요|알려\s*주세요|찾아\s*줘|찾아주세요|찾아\s*주세요|연결\s*해줘|연결해주세요/gi, ' ')
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeHqContactSearchQuery(q);
}

function detectImplicitPersonnelContactIntent(rawQuery) {
  let q = compactText(String(rawQuery || ''));
  if (!q) return null;

  // 기관명과 일반적인 질문 표현은 제거하고 핵심 업무명만 판단합니다.
  q = q
    .replace(/경상남도교육청|경남교육청|교육청|본청/g, '')
    .replace(/담당자|담당부서|담당과|담당|업무|검색|조회|안내|문의|전화번호|전화|연락처/g, '')
    .replace(/알려줘|알려주세요|찾아줘|찾아주세요|어디야|어디예요|어디에요/g, '')
    .replace(/[^가-힣a-z0-9]/gi, '');

  if (/^(?:지방)?공무원인사$/.test(q)) return { query: '지방공무원 인사' };

  // 일반 교원 인사는 담당자를 임의로 하나 고르지 않고 학교급을 먼저 구분해 안내합니다.
  if (/^(교원인사|교사인사|선생님인사)$/.test(q)) return { query: '교원 인사' };

  // 유치원 교원 인사
  if (/^(유치원교원인사|유치원교사인사|유치원선생님인사)$/.test(q)) {
    return { query: '유아특수교육과 유치원 교사 인사' };
  }

  // 초·중등 교원 인사
  if (/^중등교원인사$/.test(q)) return { query: '중등교육과 교원 인사' };
  if (/^초등교원인사$/.test(q)) return { query: '초등교육과 교원 인사' };

  // 특수교원 인사는 학교급이 없으면 먼저 유치원/초등/중등을 선택하도록 안내합니다.
  if (/^(특수교원인사|특수교사인사|특수선생님인사)$/.test(q)) return { query: '특수교원 인사' };
  if (/^(유치원특수교원인사|유치원특수교사인사|특수유치원교사인사)$/.test(q)) {
    return { query: '유아특수교육과 유치원 특수교사 인사' };
  }
  if (/^(초등특수교원인사|초등특수교사인사)$/.test(q)) {
    return { query: '초등교육과 초등특수 교원 인사' };
  }
  if (/^(중등특수교원인사|중등특수교사인사)$/.test(q)) {
    return { query: '중등교육과 중등특수 교원 인사' };
  }

  // 직위를 특정한 경우에는 그 직위의 인사업무 담당자를 공식 업무분장에서 찾습니다.
  if (/^교감인사$/.test(q)) return { query: '교감 인사' };
  if (/^교장인사$/.test(q)) return { query: '교장 인사' };
  if (/^장학관인사$/.test(q)) return { query: '장학관 인사' };
  if (/^교육연구관인사$/.test(q)) return { query: '교육연구관 인사' };
  if (/^(전문직인사|교육전문직인사|교육전문직원인사)$/.test(q)) return { query: '교육전문직원 인사' };
  if (/^장학사인사$/.test(q)) return { query: '장학사 인사' };
  if (/^교육연구사인사$/.test(q)) return { query: '교육연구사 인사' };

  // 기간제교원은 '담당자'라고 쓰지 않아도 담당자 문의 의도가 매우 명확하므로 바로 업무검색으로 연결합니다.
  if (/^(?:기간제교원|기간제교사|계약제교원|계약제교사|기간제선생님)(?:인사)?$/.test(q)) {
    return { query: '계약제교원' };
  }

  return null;
}

function detectHqContactIntent(rawQuery) {
  const raw = String(rawQuery || '').trim();

  // '담당자(본청) 안내', '담당자 안내', '담당부서', '담당업무' 등은
  // 모두 '업무담당자'와 동일한 안내 카드로 연결합니다.
  if (isHqContactMenuAlias(raw)) return { query: '' };

  const q = compactText(expandQuery(raw));
  const isContact = /(업무담당자|업무담당|담당업무|담당자|담당부서|담당과|담당|전화번호|연락처|문의처|문의|전화|누구한테|누구에게|어디로문의|어디에문의)/.test(q);
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

function rankHqContactRows(query, rows, maxResults = 10) {
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
      const literalRows = literal.map(x => x.row);
      return maxResults && maxResults > 0 ? literalRows.slice(0, maxResults) : literalRows;
    }
  }

  // 여러 단어 검색은 단어 사이에 다른 말이 끼어 있어도 모두 포함된 행을 우선합니다.
  // 예: "중등인사 인사기획" → "중등인사 및 인사기획" 매칭
  if (tokens.length >= 2) {
    const compactTokens = tokens.map(compactText).filter(Boolean);
    const allTokenRows = [];
    for (const row of (rows || [])) {
      if (isExcludedHqLeadershipRow(row)) continue;
      const haystack = compactText(`${row.department || ''} ${row.team || ''} ${row.duty || ''}`);
      if (!compactTokens.every(t => haystack.includes(t))) continue;
      const meta = hqRowMatchMeta(raw, row);
      allTokenRows.push({ row, ...meta });
    }
    if (allTokenRows.length) {
      allTokenRows.sort((a,b) => b.score-a.score || String(a.row.department).localeCompare(String(b.row.department),'ko'));
      const rowsMatched = allTokenRows.map(x=>x.row);
      return maxResults && maxResults > 0 ? rowsMatched.slice(0,maxResults) : rowsMatched;
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
  const narrowedRows = narrowed.map(x => x.row);
  return maxResults && maxResults > 0 ? narrowedRows.slice(0, maxResults) : narrowedRows;
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
  let filtered = rankHqContactRowsWithAliases(core, allRows);

  // 전체 표현이 업무분장과 맞지 않을 때만 일반적인 행동어를 덜어낸 핵심어로 재검색합니다.
  // 특정 업무를 하드코딩하지 않아 '제증명 발급', '검정고시 접수', '직업교육 지원' 등도 같이 보완됩니다.
  if (!filtered.length) {
    for (const fallback of hqContactFallbackQueries(core)) {
      const retry = rankHqContactRowsWithAliases(fallback, allRows);
      if (retry.length) {
        filtered = retry;
        break;
      }
    }
  }

  return saveHqQueryCache(core, filtered);
}

// 웹 업무담당자 검색 페이지는 카카오 말풍선보다 넓게 볼 수 있으므로 결과를 임의로 5/10건에 자르지 않습니다.
// 특히 '재정과'처럼 부서명을 정확히 입력한 경우 해당 부서의 실무담당자를 모두 보여줍니다.
async function searchGneHqContactsForWeb(query) {
  const core = normalizeHqContactSearchQuery(query);
  if (!core) return [];

  const allRows = await getAllGneHqContacts();
  const whole = compactText(core);

  const exactDeptRows = (allRows || [])
    .filter(row => !isExcludedHqLeadershipRow(row) && compactText(row && row.department || '') === whole)
    .sort((a, b) =>
      String(a.team || '').localeCompare(String(b.team || ''), 'ko') ||
      String(a.phone || '').localeCompare(String(b.phone || ''), 'ko')
    );
  if (exactDeptRows.length) return exactDeptRows;

  let filtered = rankHqContactRowsWithAliases(core, allRows, 0);
  if (!filtered.length) {
    for (const fallback of hqContactFallbackQueries(core)) {
      const retry = rankHqContactRowsWithAliases(fallback, allRows, 0);
      if (retry.length) {
        filtered = retry;
        break;
      }
    }
  }
  return filtered;
}


// '공사'는 계약업무(재정과)와 시설공사업무(시설과)가 함께 검색될 수 있어
// 사용자에게 두 분야를 나누어 보여줍니다.
function isAmbiguousConstructionQuery(query) {
  const core = compactText(normalizeHqContactSearchQuery(query));
  return /^(공사|공사업무|공사관련|공사담당|공사담당자|공사문의)$/.test(core);
}

function sortHqRowsForDisplay(rows) {
  return (rows || []).slice().sort((a, b) =>
    String(a.team || '').localeCompare(String(b.team || ''), 'ko') ||
    String(a.phone || '').localeCompare(String(b.phone || ''), 'ko')
  );
}

async function getConstructionContactGroups() {
  const allRows = await getAllGneHqContacts();
  const usable = (allRows || []).filter(row => !isExcludedHqLeadershipRow(row));

  const deptIs = (row, dept) => compactText(row && row.department || '') === compactText(dept);
  const dutyText = row => compactText(row && row.duty || '');

  // 재정과: 공사 '계약/입찰'과 직접 관련된 업무를 우선합니다.
  let finance = usable.filter(row => {
    if (!deptIs(row, '재정과')) return false;
    const d = dutyText(row);
    return d.includes('공사') && /(계약|입찰|낙찰|계약관리|전자계약)/.test(d);
  });
  // 공식 업무분장 표현에 '공사'가 생략된 경우를 대비해 계약/입찰 담당을 보완합니다.
  if (!finance.length) {
    finance = usable.filter(row => {
      if (!deptIs(row, '재정과')) return false;
      const d = dutyText(row);
      return /(계약|입찰|낙찰|전자계약)/.test(d);
    });
  }

  // 시설과: 실제 시설공사/공사관리 업무가 들어 있는 행만 우선합니다.
  let facility = usable.filter(row => {
    if (!deptIs(row, '시설과')) return false;
    const d = dutyText(row);
    return d.includes('공사') || d.includes('시설공사');
  });
  if (!facility.length) {
    facility = usable.filter(row => deptIs(row, '시설과') && /(시설|건축|토목|전기|기계|공사)/.test(dutyText(row)));
  }

  return {
    finance: sortHqRowsForDisplay(finance),
    facility: sortHqRowsForDisplay(facility)
  };
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
              { label: '🔎 본청 업무담당자 검색', action: 'webLink', webLinkUrl: `${PUBLIC_BASE_URL}/staff-search?v=phonefix3` },
              { label: '🏫 지역교육청 안내', action: 'webLink', webLinkUrl: `${PUBLIC_BASE_URL}/staff-search?regional=1&v=phonefix3` }
            ]
          }
        }
      ]
    }
  };
}


function isGeneralTeacherPersonnelQuery(query) {
  const q = compactText(String(query || ''))
    .replace(/경상남도교육청|경남교육청|교육청|본청/g, '')
    .replace(/담당자|담당부서|담당과|담당|업무|검색|조회|안내|문의|전화번호|전화|연락처/g, '')
    .replace(/[^가-힣a-z0-9]/gi, '');
  return /^(교원인사|교사인사|선생님인사)$/.test(q);
}

function kakaoTeacherPersonnelGuideResponse() {
  const text = [
    '교원 인사는 학교급과 직위에 따라 담당자가 달라요.',
    '',
    '• 유치원 교원 인사 → 유아특수교육과',
    '• 초등교원 인사 → 초등교육과',
    '• 중등교원 인사 → 중등교육과',
    '• 특수교원 인사 → 학교급에 따라 담당부서가 달라요.',
    '',
    '교사(선생님), 교감, 교장, 장학관·교육연구관, 교육전문직(장학사·교육연구사) 등 직위에 따라 담당자가 다를 수 있습니다.',
    '아래에서 학교급을 선택하거나 「업무담당자 검색」에서 업무명을 구체적으로 검색해 주세요.'
  ].join('\n');

  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text } }],
      quickReplies: [
        { label: '유치원 교원 인사', action: 'message', messageText: '유치원 교사 인사 담당자' },
        { label: '초등교원 인사', action: 'message', messageText: '초등교육과 교원 인사 담당자' },
        { label: '중등교원 인사', action: 'message', messageText: '중등교육과 교원 인사 담당자' },
        { label: '특수교원 인사', action: 'message', messageText: '특수교사 인사' },
        { label: '🔎 업무담당자 검색', action: 'message', messageText: '업무담당자' }
      ]
    }
  };
}

function isGeneralSpecialTeacherPersonnelQuery(query) {
  const q = compactText(String(query || ''))
    .replace(/경상남도교육청|경남교육청|교육청|본청/g, '')
    .replace(/담당자|담당부서|담당과|담당|업무|검색|조회|안내|문의|전화번호|전화|연락처/g, '')
    .replace(/[^가-힣a-z0-9]/gi, '');
  return /^(특수교원인사|특수교사인사|특수선생님인사)$/.test(q);
}

function kakaoSpecialTeacherPersonnelGuideResponse() {
  const text = [
    '특수교원 인사는 학교급에 따라 담당부서가 달라요.',
    '',
    '• 유치원 특수교사 인사 → 유아특수교육과',
    '• 초등특수교원 인사 → 초등교육과',
    '• 중등특수교원 인사 → 중등교육과',
    '',
    '아래에서 학교급을 선택하면 해당 업무담당자와 전화번호를 찾아드려요.'
  ].join('\n');

  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text } }],
      quickReplies: [
        { label: '유치원 특수교사', action: 'message', messageText: '유치원 특수교사 인사 담당자' },
        { label: '초등특수교원', action: 'message', messageText: '초등특수교원 인사 담당자' },
        { label: '중등특수교원', action: 'message', messageText: '중등특수교원 인사 담당자' },
        { label: '🔎 업무담당자 검색', action: 'message', messageText: '업무담당자' }
      ]
    }
  };
}

function isGneCallCenterContactQuery(query) {
  const q = compactText(String(query || ''))
    .replace(/경상남도교육청|경남교육청|교육청|본청/g, '')
    .replace(/업무담당자|담당자|담당부서|담당과|담당|업무|검색|조회|안내|문의|전화번호|전화|연락처/g, '');
  return /^(경남교육콜센터|교육콜센터|콜센터)$/.test(q);
}

function kakaoGneCallCenterContactResponse() {
  const contact = {
    department: '총무과',
    team: '민원기록',
    phone: '055-268-1367',
    duty: '청원제도 운영 ㆍ 경남교육 콜센터 운영·관리 ㆍ 안내원 직종 관리 및 교육 ㆍ 제증명 및 인ㆍ허가 민원 운영ㆍ관리 ㆍ 민원기록담당 일반 서무에 관한 사항 ㆍ 민원처리자 심리상담비 지원 ㆍ 민원처리기준표 및 민원편람 관리'
  };
  return {
    version: '2.0',
    template: {
      outputs: [
        { simpleText: { text: `경남교육콜센터 담당자입니다.\n\n${contact.department} / ${contact.team}\n☎ ${contact.phone}\n\nㆍ 청원제도 운영\nㆍ 경남교육 콜센터 운영·관리\nㆍ 안내원 직종 관리 및 교육\nㆍ 제증명 및 인ㆍ허가 민원 운영ㆍ관리\nㆍ 민원기록담당 일반 서무에 관한 사항\nㆍ 민원처리자 심리상담비 지원\nㆍ 민원처리기준표 및 민원편람 관리` } },
        {
          basicCard: {
            title: '총무과 / 민원기록',
            description: contact.duty,
            buttons: [{ label: '☎ 담당자 전화', action: 'phone', phoneNumber: '0552681367' }]
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

  // 경남교육콜센터 담당자는 민원기록 담당 1건만 고정 안내합니다.
  if (isGneCallCenterContactQuery(query)) {
    return kakaoGneCallCenterContactResponse();
  }

  // 학교급/직위가 특정되지 않은 교원 인사는 유치원/초등/중등/특수 담당부서를 먼저 안내합니다.
  if (isGeneralTeacherPersonnelQuery(query)) {
    return kakaoTeacherPersonnelGuideResponse();
  }

  // 특수교원 인사는 학교급에 따라 담당부서가 달라 먼저 학교급을 선택하도록 안내합니다.
  if (isGeneralSpecialTeacherPersonnelQuery(query)) {
    return kakaoSpecialTeacherPersonnelGuideResponse();
  }

  try {
    if (isAmbiguousConstructionQuery(query)) {
      const groups = await getConstructionContactGroups();
      const finance = (groups.finance || []).slice(0, 2);
      const facility = (groups.facility || []).slice(0, 2);
      const lines = [
        "'공사'는 담당 분야에 따라 부서가 달라요.",
        '',
        '💰 계약·입찰 등 계약 관련 → 재정과',
        '🏗️ 시설공사 추진·관리 등 공사 관련 → 시설과'
      ];
      if (finance.length) {
        lines.push('', '재정과 업무담당자');
        finance.forEach(c => lines.push(`☎ ${c.phone} · ${truncateOfficialDuty(c.duty, 80)}`));
      }
      if (facility.length) {
        lines.push('', '시설과 업무담당자');
        facility.forEach(c => lines.push(`☎ ${c.phone} · ${truncateOfficialDuty(c.duty, 80)}`));
      }
      return {
        version: '2.0',
        template: {
          outputs: [{ simpleText: { text: lines.join('\n').slice(0, 950) } }],
          quickReplies: [
            { label: '💰 계약 관련(재정과)', action: 'message', messageText: '재정과 공사 계약 담당자' },
            { label: '🏗️ 공사 관련(시설과)', action: 'message', messageText: '시설과 공사 담당자' }
          ]
        }
      };
    }
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

// scenarios.json에 저장된 버튼(url/phone/block/text/plugin)을
// 카카오 스킬 응답 버튼 형식으로 최대한 원본과 똑같이 변환합니다.
// - url   -> 웹링크 버튼
// - phone -> 전화 버튼
// - block -> 값에 담긴 "[블록ID]"를 그대로 읽어 다른 블록으로 이동하는 버튼
// - text  -> 눌렀을 때 그 문구를 입력한 것처럼 처리하는 버튼
// - plugin(상담원 연결 등) -> 스킬 응답으로는 플러그인을 직접 열 수 없어
//   최대한 비슷하게 문구 전송 버튼으로 대체합니다.
function buildKakaoButtonsFromScenarioButtons(buttons) {
  return (buttons || []).map(b => {
    const label = String(b.label || '').slice(0, 14) || '바로가기';
    const value = String(b.value || '');
    if (b.type === 'url') {
      return { label, action: 'webLink', webLinkUrl: value };
    }
    if (b.type === 'phone') {
      return { label, action: 'phone', phoneNumber: value };
    }
    if (b.type === 'block') {
      const m = value.match(/\[([0-9a-f]{24})\]\s*$/i);
      if (m && m[1]) {
        return { label, action: 'block', blockId: m[1], messageText: label };
      }
      return { label, action: 'message', messageText: label };
    }
    if (b.type === 'text') {
      let text = value;
      try { text = decodeURIComponent(value); } catch (e) { /* 값이 이미 일반 텍스트면 그대로 사용 */ }
      return { label, action: 'message', messageText: text || label };
    }
    // plugin 등 스킬 응답에서 직접 지원하지 않는 타입은 문구 전송으로 안전하게 대체
    return { label, action: 'message', messageText: label };
  }).filter(Boolean).slice(0, 3);
}

// scenarios.json의 블록 하나(원래 오픈빌더 응답)를 카카오 스킬 응답 outputs로 재구성합니다.
// 메시지 + 버튼을 basicCard 하나로 묶어서, 텍스트카드와 버튼카드가 따로 나가던 기존 방식보다
// 원본 카드형 응답에 훨씬 가깝게 보이도록 합니다.
// 카드형 응답이 연속으로 2개 이상이면(예: 종합 안내 + 구비서류) 세로로 따로 나가지 않도록
// 캐러셀(가로 스와이프) 하나로 묶어서 보여줍니다.
function buildKakaoOutputsFromScenarioBlock(block) {
  const items = [];
  (block.responses || []).forEach(r => {
    const message = String(r.message || '').trim();
    const buttons = buildKakaoButtonsFromScenarioButtons(r.buttons || []);
    if (buttons.length) {
      items.push({ kind: 'card', basicCard: { description: message || ' ', buttons } });
    } else if (message) {
      items.push({ kind: 'text', simpleText: { text: message } });
    }
  });

  const outputs = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].kind === 'card') {
      const cards = [];
      while (i < items.length && items[i].kind === 'card') {
        cards.push(items[i].basicCard);
        i++;
      }
      // 카카오 캐러셀은 최소 2개부터 지원하므로, 카드가 1개면 그냥 basicCard로 둡니다.
      if (cards.length >= 2) {
        outputs.push({ carousel: { type: 'basicCard', items: cards.slice(0, 10) } });
      } else {
        outputs.push({ basicCard: cards[0] });
      }
    } else {
      outputs.push({ simpleText: items[i].simpleText });
      i++;
    }
  }
  return outputs;
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
  const showHumanHelp = failCount >= 1;
  // 폴백에서는 유사 후보 몇 개만 보여주지 않고, 웰컴블록(챗봇 이용 안내)에
  // 등록된 전체 바로연결 메뉴를 그대로 노출합니다.
  // 따라서 웰컴블록에서 제증명·검정고시·전입학 등의 메뉴를 수정하면 폴백에도 자동 반영됩니다.
  const welcomeBlock = blocks.find(b => (b.title || '').trim() === '챗봇 이용 안내');
  let quickReplies = welcomeBlock ? buildBlockQuickReplies(welcomeBlock, blocks) : [];

  // 혹시 웰컴블록을 찾지 못하는 예외 상황에서는 기존 질문 인식 불가 안내 블록 메뉴를 사용합니다.
  if (!quickReplies.length) {
    const fallbackBlock = blocks.find(b => (b.title || '').trim() === '질문 인식 불가 안내');
    if (fallbackBlock) quickReplies = buildBlockQuickReplies(fallbackBlock, blocks);
  }

  // 첫 번째 인식 실패부터 1:1 채팅상담을 바로 노출합니다.
  // 첫 번째 인식 실패부터 1:1 채팅상담과 콜센터를 함께 노출하고, 전학 AI 참고 링크는 기존 기준대로 추가합니다.
  const cardButtons = [];

  if (showHumanHelp) {
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
    : '제가 질문을 정확히 이해하지 못했어요😥\n조금 더 구체적으로 다시 말씀해주시거나 아래 관련 항목을 선택해주세요.\n\n💡바로 상담이 필요하시면 1:1 채팅상담 또는 경남교육콜센터(055-268-1004)를 이용해주세요.';

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



// 질문 내용에 따라 민원 통합안내 웹페이지 바로가기 버튼을 자동으로 붙입니다.
function withGuideQuickReply(payload, utterance) {
  if (!payload || !payload.template) return payload;

  const q = String(utterance || '').trim();
  if (!q) return payload;

  let guide = null;

  // 구체적인 증명서 질문은 제증명 안내를 우선합니다.
  if (/(제증명|증명서|생활기록부|생기부|졸업증명|성적증명|재학증명|경력증명|재직증명|퇴직증명|폐교.*증명)/i.test(q)) {
    guide = {
      label: '🔍 증명서 자주 묻는 질문',
      url: `${PUBLIC_BASE_URL}/certificates`
    };
  } else if (/(검정고시)/i.test(q)) {
    guide = {
      label: '🔍 검정고시 자주 묻는 질문',
      url: `${PUBLIC_BASE_URL}/ged`
    };
  } else if (/(수능|대학수학능력시험|수학능력시험)/i.test(q)) {
    guide = {
      label: '🔍 수능 자주 묻는 질문',
      url: `${PUBLIC_BASE_URL}/csat`
    };
  } else if (/(전학|전입학|전입|편입학|편입)/i.test(q)) {
    guide = {
      label: '🔍 전·입학 자주 묻는 질문',
      url: `${PUBLIC_BASE_URL}/transfer`
    };
  }

  if (!guide) return payload;

  const quickReplies = Array.isArray(payload.template.quickReplies)
    ? payload.template.quickReplies.slice()
    : [];

  const exists = quickReplies.some(x =>
    String((x && x.webLinkUrl) || '') === guide.url ||
    String((x && x.label) || '') === guide.label
  );

  if (!exists) {
    // 자동 안내 버튼은 잘 보이도록 첫 번째에 둡니다.
    quickReplies.unshift({
      label: guide.label,
      action: 'webLink',
      webLinkUrl: guide.url
    });
  }

  payload.template.quickReplies = quickReplies.slice(0, 10);
  return payload;
}

function withStaffSearchQuickReply(payload) {
  if (!payload || !payload.template) return payload;

  const outputBlob = JSON.stringify(payload.template.outputs || []);
  const hasContactInfo = /(담당자|담당부서|담당과|담당업무|문의처|문의전화)/.test(outputBlob)
    || /055[- ]?\d{3,4}[- ]?\d{4}/.test(outputBlob);

  // 담당자 관련 정보가 없는 일반 답변에는 노출하지 않습니다.
  if (!hasContactInfo) return payload;

  // 카드 안에 담당자 검색 링크가 있더라도 노란 바로연결 버튼은 계속 유지합니다.
  // 사용자가 한 번 버튼을 눌러 다음 응답으로 이동한 뒤에도 다시 업무담당자 검색을 이어갈 수 있게 합니다.
  const quickReplies = Array.isArray(payload.template.quickReplies)
    ? payload.template.quickReplies.slice()
    : [];

  const label = '🔎 업무담당자 검색';
  const alreadyHasStaffSearch = quickReplies.some(q =>
    /업무담당자\s*검색|담당자검색/.test(String((q && q.label) || '')) ||
    /담당자$/.test(String((q && q.messageText) || '').trim())
  );
  if (!alreadyHasStaffSearch && !quickReplies.some(q => String((q && q.label) || '') === label)) {
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

// 카카오 스킬 payload의 flow.trigger.type을 이용해 직접입력/버튼클릭을 구분합니다.
// 카카오 payload 버전에 따라 flow가 최상위 또는 userRequest 아래에 있을 수 있어 둘 다 확인합니다.
function getKakaoInteractionMeta(body) {
  const payload = body || {};
  const flow = payload.flow || (payload.userRequest && payload.userRequest.flow) || {};
  const trigger = flow.trigger || {};
  const triggerType = String(trigger.type || '').trim();
  const referrerBlock = trigger.referrerBlock || {};
  const lastBlock = flow.lastBlock || {};
  const currentBlock = (payload.userRequest && payload.userRequest.block) || payload.intent || {};
  const utterance = String((payload.userRequest && payload.userRequest.utterance) || '').trim();

  const isButton = /(?:BUTTON|LIST_ITEM|LISTMENU|QUICKREPLY)/i.test(triggerType);
  let inputType = '미확인';
  if (triggerType === 'TEXT_INPUT') inputType = '직접입력';
  else if (isButton) inputType = '버튼클릭';
  else if (triggerType) inputType = '기타';

  return {
    inputType,
    triggerType,
    buttonText: isButton ? utterance : '',
    referrerBlock: String(referrerBlock.name || '').trim(),
    referrerBlockId: String(referrerBlock.id || '').trim(),
    currentBlock: String(currentBlock.name || '').trim(),
    currentBlockId: String(currentBlock.id || '').trim(),
    lastBlock: String(lastBlock.name || '').trim(),
    lastBlockId: String(lastBlock.id || '').trim()
  };
}

// 통계용: 맞았든 못 맞았든 모든 질문을 기록
function trackQuery(query, matchedTitle, matched, source, visitorId, interactionMeta = null) {
  const list = readJson(QUERIES_PATH, []);
  const meta = interactionMeta && typeof interactionMeta === 'object' ? interactionMeta : {};
  const inferredInputType = meta.inputType || (String(source || '').startsWith('web') ? '웹입력' : '');
  list.push({
    time: new Date().toISOString(),
    query: query||'',
    matchedTitle: matchedTitle||'',
    matched: !!matched,
    source: source||'unknown',
    visitorId: visitorId||'',
    inputType: inferredInputType,
    triggerType: meta.triggerType || '',
    buttonText: meta.buttonText || '',
    referrerBlock: meta.referrerBlock || '',
    referrerBlockId: meta.referrerBlockId || '',
    currentBlock: meta.currentBlock || '',
    currentBlockId: meta.currentBlockId || '',
    lastBlock: meta.lastBlock || '',
    lastBlockId: meta.lastBlockId || ''
  });
  if (list.length > 20000) list.shift();
  writeJson(QUERIES_PATH, list);
}

// 방문자ID를 표시용으로 일부만 보여줍니다. "kakao:실제ID"처럼 출처 접두사가 붙어있으면
// 접두사는 그대로 두고 실제 ID 쪽에서 앞 6자만 보여줘야 서로 구분이 됩니다.
function maskVisitorId(id) {
  const s = String(id || '');
  const idx = s.indexOf(':');
  if (idx > -1 && idx < 12) {
    const prefix = s.slice(0, idx + 1);
    const rest = s.slice(idx + 1);
    return prefix + rest.slice(0, 6) + '…';
  }
  return s.slice(0, 6) + '…';
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

function getMissedSummary(listOverride = null) {
  const list = Array.isArray(listOverride) ? listOverride : readJson(MISSED_PATH, []);
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
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
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
  .search button,.region-toggle,.dept-toggle{height:46px;border:0;border-radius:10px;padding:0 17px;font-size:15px;font-weight:700;background:#fee500;color:#191919;cursor:pointer}
  .region-toggle,.dept-toggle{width:100%;margin-top:12px;background:#eef2f6}
  .examples{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.chip{border:1px solid #e1e5e9;background:#fff;border-radius:999px;padding:7px 10px;font-size:13px;cursor:pointer}
  #regionBox,#deptBox{display:none;margin-top:12px;padding-top:13px;border-top:1px solid #edf0f2}.region-title,.dept-title{font-size:14px;font-weight:800;margin-bottom:4px}.region-help,.dept-help{font-size:12px;line-height:1.5;color:#777;margin-bottom:10px}
  .regions,.depts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.region-link,.dept-link{display:block;text-decoration:none;text-align:center;border:1px solid #dfe4e8;background:#fff;border-radius:10px;padding:10px 7px;color:#222;font-size:13px;font-weight:700;cursor:pointer}.dept-count{display:block;font-size:11px;color:#888;font-weight:500;margin-top:2px}
  #status{font-size:14px;color:#666;margin:16px 2px 8px}.result{background:#fff;border-radius:14px;padding:15px 16px;margin-top:10px;box-shadow:0 1px 8px rgba(0,0,0,.05)}
  .dept{font-weight:800;font-size:16px;margin-bottom:6px}.phone{display:inline-block;margin:2px 0 8px;font-weight:700;color:#1b5dbf;text-decoration:none}
  .duty{font-size:14px;line-height:1.55;white-space:pre-wrap;color:#444}
  .hl{color:#1b5dbf;font-weight:800}
  .clarify{background:#fff7cc;border:1px solid #ffe36b;border-radius:14px;padding:14px 15px;margin-top:10px;line-height:1.55}.clarify-title{font-weight:800;margin-bottom:4px}.group{margin-top:14px}.group-title{font-size:16px;font-weight:800;margin:0 0 8px}.group-desc{font-size:13px;color:#666;margin:-3px 0 8px}.group .result{margin-top:8px;border:1px solid #eef1f4;box-shadow:none}
  .notice{font-size:12px;line-height:1.55;color:#777;margin-top:16px}.empty{background:#fff;border-radius:14px;padding:18px;margin-top:10px;color:#555}
  @media(min-width:560px){.regions,.depts{grid-template-columns:repeat(3,minmax(0,1fr))}}
.dept{font-weight:800;font-size:16px;margin-bottom:6px}.phone{display:inline-block;margin:2px 0 8px;font-weight:700;color:#1b5dbf;text-decoration:none}
  .phone-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:3px 0 10px}
  .phone-number{font-weight:800;color:#1b5dbf}
  .call-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:7px 12px;border-radius:10px;background:#fee500;color:#191919!important;text-decoration:none!important;font-weight:900}
  .duty
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>본청 업무담당자 검색</h1><div style="font-size:11px;color:#999;margin-top:-2px;margin-bottom:4px">전화연결 적용 v3</div>
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
      <button class="chip" data-q="공사">공사</button>
    </div>
    <div id="status"></div>
    <div id="results"></div>
    <button id="deptToggle" class="dept-toggle" type="button">🏢 본청 부서 보기</button>
    <div id="deptBox">
      <div class="dept-title">경상남도교육청 본청 부서</div>
      <div class="dept-help">부서를 누르면 해당 부서의 실무담당자 업무분장을 모두 검색합니다. 검색하면 이 목록은 자동으로 접혀 결과가 먼저 보입니다.</div>
      <div id="depts" class="depts"></div>
    </div>
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
const deptToggle=document.getElementById('deptToggle'), deptBox=document.getElementById('deptBox'), depts=document.getElementById('depts');
const regionToggle=document.getElementById('regionToggle'), regionBox=document.getElementById('regionBox');
function esc(v){return String(v??'').replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]));}
function escRe(v){return String(v||'').replace(/[.*+?^$(){}|[\\]]/g,function(m){return String.fromCharCode(92)+m;});}
function hl(text,terms){
  const raw=String(text??'');
  const uniq=[...new Set((terms||[]).map(t=>String(t||'').trim()).filter(Boolean))]
    .sort((a,b)=>b.length-a.length);
  if(!uniq.length) return esc(raw);

  // 각 검색어를 서로 독립적으로 찾습니다.
  // 예: 검색어 "중등인사 인사기획", 실제 문장 "중등인사 및 인사기획"
  //     → "중등인사"와 "인사기획"만 각각 강조하고 중간의 "및"은 그대로 둡니다.
  const lower=raw.toLowerCase();
  const ranges=[];
  uniq.forEach(term=>{
    const needle=term.toLowerCase();
    if(!needle) return;
    let from=0;
    while(from<lower.length){
      const idx=lower.indexOf(needle,from);
      if(idx<0) break;
      ranges.push([idx,idx+needle.length]);
      from=idx+Math.max(1,needle.length);
    }
  });
  if(!ranges.length) return esc(raw);

  ranges.sort((a,b)=>a[0]-b[0] || b[1]-a[1]);
  const merged=[];
  ranges.forEach(r=>{
    const last=merged[merged.length-1];
    if(!last || r[0]>last[1]) merged.push(r.slice());
    else if(r[1]>last[1]) last[1]=r[1];
  });

  let html='', pos=0;
  merged.forEach(([start,end])=>{
    html+=esc(raw.slice(pos,start));
    html+='<span class="hl">'+esc(raw.slice(start,end))+'</span>';
    pos=end;
  });
  html+=esc(raw.slice(pos));
  return html;
}
function tel(v){
  const raw=String(v||'').trim();
  const digits=raw.replace(/[^0-9]/g,'');
  if(digits.length<9) return '';
  return digits;
}
function setRegion(open){regionBox.style.display=open?'block':'none';regionToggle.textContent=open?'🏫 지역교육청 안내 닫기':'🏫 지역교육청 안내 보기';}
function setDept(open){deptBox.style.display=open?'block':'none';deptToggle.textContent=open?'🏢 본청 부서 닫기':'🏢 본청 부서 보기';}
regionToggle.addEventListener('click',()=>{setDept(false);setRegion(regionBox.style.display!=='block');});
deptToggle.addEventListener('click',()=>{setRegion(false);setDept(deptBox.style.display!=='block');});
async function loadDepartments(){
  try{
    const r=await fetch('/api/hq-departments',{cache:'no-store'}); const d=await r.json();
    const list=Array.isArray(d.departments)?d.departments:[];
    depts.innerHTML=list.map(x=>'<button class="dept-link" type="button" data-dept="'+esc(x.name)+'">'+esc(x.name)+'<span class="dept-count">실무 '+esc(x.count)+'명</span></button>').join('');
    depts.querySelectorAll('.dept-link').forEach(b=>b.addEventListener('click',()=>{q.value=b.dataset.dept||'';setDept(false);search();}));
  }catch(_){depts.innerHTML='<div class="empty">본청 부서 목록을 불러오지 못했습니다.</div>';}
}
loadDepartments();
const pageParams=new URLSearchParams(location.search);
const regionalMode=pageParams.get('regional')==='1';
setDept(!regionalMode);
if(regionalMode){setRegion(true);setTimeout(()=>regionBox.scrollIntoView({behavior:'smooth',block:'start'}),100);}
const presetQuery=(pageParams.get('query')||'').trim();
if(presetQuery) q.value=presetQuery;
async function search(){
  const query=q.value.trim();
  if(!query){q.focus();return;}
  setDept(false); setRegion(false);
  btn.disabled=true; status.textContent='검색 중입니다…'; results.innerHTML='';
  try{
    const r=await fetch('/api/hq-contact?query='+encodeURIComponent(query),{cache:'no-store'});
    const d=await r.json();
    if(!r.ok||!d.ok) throw new Error(d.message||'검색에 실패했습니다.');
    // 검색어가 여러 단어이면 각 단어를 독립적으로 강조합니다.\n    // 예: '고등학교 전입학' → 결과 문장 안에서 두 단어가 서로 떨어져 있어도 각각 파란색 표시\n    const terms=(query.match(/[가-힣A-Za-z0-9]+/g)||[]).map(x=>x.trim()).filter(Boolean);
    const renderContact=c=>{
      const dial=tel(c.phone);
      const phoneText=esc(c.phone||'');
      const phone=dial
        ? '<div class="phone-row"><span class="phone-number">☎ '+phoneText+'</span><a class="call-btn" href="tel:'+dial+'">📞 바로 전화걸기</a></div>'
        : '<div class="phone">☎ '+phoneText+'</div>';
      return '<div class="result"><div class="dept">'+hl(c.department||'',terms)+(c.team?' / '+hl(c.team,terms):'')+'</div>'+phone+'<div class="duty">'+hl(c.duty||'',terms)+'</div></div>';
    };
    if(d.disambiguation==='construction'){
      const finance=Array.isArray(d.groups&&d.groups.finance)?d.groups.finance:[];
      const facility=Array.isArray(d.groups&&d.groups.facility)?d.groups.facility:[];
      const total=finance.length+facility.length;
      status.textContent="'공사' 관련 업무를 분야별로 나눠 안내합니다.";
      results.innerHTML='<div class="clarify"><div class="clarify-title">어떤 공사 업무를 찾으시나요?</div>계약·입찰 등 <b>계약 관련은 재정과</b>, 시설공사 추진·관리 등 <b>공사 관련은 시설과</b>에서 확인해 주세요.</div>'+
        '<div class="group"><div class="group-title">💰 계약 관련 · 재정과</div><div class="group-desc">공사 계약·입찰 등 계약 업무담당자</div>'+(finance.length?finance.map(renderContact).join(''):'<div class="empty">재정과의 공사 계약 관련 업무담당자를 찾지 못했습니다.</div>')+'</div>'+
        '<div class="group"><div class="group-title">🏗️ 공사 관련 · 시설과</div><div class="group-desc">시설공사 추진·관리 등 공사 업무담당자</div>'+(facility.length?facility.map(renderContact).join(''):'<div class="empty">시설과의 공사 관련 업무담당자를 찾지 못했습니다.</div>')+'</div>';
      setTimeout(()=>status.scrollIntoView({behavior:'smooth',block:'start'}),30);
      return;
    }
    const list=Array.isArray(d.contacts)?d.contacts:[];
    status.textContent="'"+query+"' 검색 결과 "+list.length+"건";
    if(!list.length){results.innerHTML='<div class="empty">본청 관련 실무담당자를 찾지 못했습니다. 지역교육지원청 소관 업무라면 아래의 <b>지역교육청 안내</b>를 이용해 주세요.</div>';return;}
    results.innerHTML=list.map(renderContact).join('');
    setTimeout(()=>status.scrollIntoView({behavior:'smooth',block:'start'}),30);
  }catch(e){status.textContent='';results.innerHTML='<div class="empty">'+esc(e.message||'검색 중 오류가 발생했습니다.')+' 잠시 후 다시 이용해 주세요.</div>';}
  finally{btn.disabled=false;}
}
btn.addEventListener('click',search); q.addEventListener('keydown',e=>{if(e.key==='Enter')search();});
document.querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{q.value=b.dataset.q||'';search();}));
if(presetQuery) setTimeout(search,60);


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
    if (isAmbiguousConstructionQuery(query)) {
      const groups = await getConstructionContactGroups();
      const count = (groups.finance || []).length + (groups.facility || []).length;
      return res.json({
        ok: true,
        query,
        count,
        disambiguation: 'construction',
        groups,
        officialUrl: GNE_HQ_WORK_SEARCH_URL
      });
    }
    const contacts = await searchGneHqContactsForWeb(query);
    return res.json({ ok: true, query, count: contacts.length, contacts, officialUrl: GNE_HQ_WORK_SEARCH_URL });
  } catch (err) {
    console.error('본청 업무담당자 테스트 API 오류:', err && err.message ? err.message : err);
    return res.status(502).json({ ok: false, message: '경상남도교육청 공식 업무검색 조회에 실패했습니다.', officialUrl: GNE_HQ_WORK_SEARCH_URL });
  }
});

// 본청 업무담당자 검색 페이지의 부서 목록. 공식 업무분장 캐시에서 부서명을 자동 추출합니다.
app.get('/api/hq-departments', async (req, res) => {
  try {
    const rows = await getAllGneHqContacts();
    const counts = new Map();
    for (const row of (rows || [])) {
      if (isExcludedHqLeadershipRow(row)) continue;
      const name = String(row && row.department || '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const departments = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    res.json({ ok: true, count: departments.length, departments });
  } catch (err) {
    res.status(502).json({ ok: false, message: '본청 부서 목록을 불러오지 못했습니다.', departments: [] });
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


// ============ 경상남도교육청 공식 누리집 자동검색 ============
// 시나리오에 없는 정책/사업/안내 질문은 경남교육청 공식 통합검색(search.gne.go.kr)을 조회합니다.
// 생성형 AI 없이 공식 검색결과의 제목/본문 일부/링크만 사용하므로 자료에 없는 내용을 임의 생성하지 않습니다.
const GNE_OFFICIAL_SEARCH_URL = 'https://search.gne.go.kr/home/front/Search.jsp';
const GNE_OFFICIAL_SEARCH_FORM_TTL_MS = 12 * 60 * 60 * 1000;
const GNE_OFFICIAL_SEARCH_QUERY_TTL_MS = 30 * 60 * 1000;
const GNE_OFFICIAL_SEARCH_MAX_RESULTS = 8;
let GNE_OFFICIAL_SEARCH_FORM_CACHE = null;
const GNE_OFFICIAL_SEARCH_QUERY_CACHE = new Map();

function normalizeOfficialSearchText(value) {
  return String(value || '')
    .replace(/경상남도교육청|경남교육청|경남교육|교육청\s*본청|교육청/gi, ' ')
    .replace(/[?!.~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function officialSearchCore(rawQuery) {
  let q = normalizeOfficialSearchText(rawQuery);
  if (!q) return '';

  q = q
    .replace(/(?:에\s*대해|에\s*대한|관련해서|관련하여|관련된)\s*/g, ' ')
    .replace(/(?:알려\s*줘|알려주세요|알려\s*주세요|찾아\s*줘|찾아주세요|찾아\s*주세요|검색\s*해줘|검색해주세요|궁금해|궁금합니다|확인해줘|확인해주세요)$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = (q.match(/[가-힣A-Za-z0-9]+/g) || []).filter(Boolean);
  const generic = new Set(['안내','관련','정보','자료','내용','알려줘','알려주세요','검색','확인','문의']);
  tokens = tokens.filter(t => !generic.has(t));

  // 예) '유보통합 추진 안내' -> '유보통합', '다자녀 지원 안내' -> '다자녀'
  const tailGeneric = new Set(['추진','운영','사업','정책','계획','지원','신청','접수','발급','신고','방법','절차']);
  if (tokens.length >= 2 && tailGeneric.has(tokens[tokens.length - 1])) tokens.pop();

  let core = tokens.join(' ').trim() || q;
  const compact = core.replace(/\s+/g, '');
  for (const suffix of ['추진안내','사업안내','정책안내','운영안내','추진','안내']) {
    if (compact.endsWith(suffix)) {
      const stem = compact.slice(0, -suffix.length);
      if (stem.length >= 2) {
        core = stem;
        break;
      }
    }
  }
  return core.trim();
}

function shouldTryOfficialGneSearch(rawQuery) {
  const raw = String(rawQuery || '').trim();
  const core = officialSearchCore(raw);
  if (!core || compactText(core).length < 2) return false;
  if (!/[가-힣A-Za-z]/.test(core)) return false;

  const compact = compactText(raw);
  if (/^(안녕|안녕하세요|하이|헬로|고마워|감사|감사합니다|땡큐|잘가|종료|끝|취소|네|넵|응|웅|ㅇㅇ)$/.test(compact)) return false;
  if (/^(뭐해|뭐함|심심해|배고파|사랑해|ㅋㅋ+|ㅎㅎ+|ㅠ+|ㅜ+)$/.test(compact)) return false;
  return true;
}

function discoverGneOfficialSearchFormFromHtml(html) {
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
      const hint = `${a.name || ''} ${a.id || ''} ${a.placeholder || ''}`.toLowerCase();
      return /(query|keyword|search|searchword|searchtext|kwd|qt|검색어)/.test(hint);
    }) || inputs.find(a => ['text','search'].includes(String(a.type || 'text').toLowerCase()));
    if (!searchInput) continue;

    const action = String(formAttrs.action || '');
    const plain = htmlFragmentToText(inner);
    let score = 0;
    if (/Search\.jsp/i.test(action)) score += 100;
    if (/통합검색|검색어/.test(plain)) score += 40;
    if (/(query|keyword|search|kwd|qt)/i.test(searchInput.name || '')) score += 25;

    const hidden = {};
    inputs.forEach(a => {
      if (String(a.type || '').toLowerCase() === 'hidden' && a.name) hidden[a.name] = a.value || '';
    });

    forms.push({
      score,
      method: String(formAttrs.method || 'GET').toUpperCase(),
      action: action || GNE_OFFICIAL_SEARCH_URL,
      queryField: searchInput.name,
      hidden
    });
  }

  if (!forms.length) return null;
  forms.sort((a,b) => b.score - a.score);
  const best = forms[0];
  try { best.action = new URL(best.action, GNE_OFFICIAL_SEARCH_URL).href; }
  catch (_) { best.action = GNE_OFFICIAL_SEARCH_URL; }
  return best;
}

async function getGneOfficialSearchForm() {
  if (GNE_OFFICIAL_SEARCH_FORM_CACHE && Date.now() - GNE_OFFICIAL_SEARCH_FORM_CACHE.updatedAt < GNE_OFFICIAL_SEARCH_FORM_TTL_MS) {
    return GNE_OFFICIAL_SEARCH_FORM_CACHE.form;
  }
  const html = await fetchOfficialGneHtml(GNE_OFFICIAL_SEARCH_URL, 1800);
  const form = discoverGneOfficialSearchFormFromHtml(html);
  if (!form || !form.queryField) throw new Error('경남교육청 통합검색 입력 항목을 찾지 못했습니다.');
  GNE_OFFICIAL_SEARCH_FORM_CACHE = { updatedAt: Date.now(), form };
  return form;
}

async function fetchGneOfficialSearchHtml(query, timeoutMs = 2500) {
  const form = await getGneOfficialSearchForm();
  const params = new URLSearchParams({ ...(form.hidden || {}), [form.queryField]: query });
  const method = String(form.method || 'GET').toUpperCase();
  const headers = {
    'accept': 'text/html,application/xhtml+xml',
    'user-agent': 'GNE-1004-Chatbot/1.0',
    'referer': GNE_OFFICIAL_SEARCH_URL
  };
  let url = form.action || GNE_OFFICIAL_SEARCH_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = { method, signal: controller.signal, headers };
    if (method === 'GET') {
      url += (url.includes('?') ? '&' : '?') + params.toString();
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      options.body = params.toString();
    }
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`경남교육청 통합검색 HTTP ${response.status}`);
    return { html: await response.text(), searchUrl: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

function officialGneUrlFromRaw(rawUrl, baseUrl = GNE_OFFICIAL_SEARCH_URL) {
  let value = decodeHtmlEntities(String(rawUrl || '')).trim();
  if (!value || /^javascript:void/i.test(value) || value === '#') return '';

  if (/^\/(?:www|user|pr|works|common|upload|files?)\//i.test(value)) {
    value = `https://www.gne.go.kr${value}`;
  }

  if (/^javascript:/i.test(value)) {
    const m = value.match(/https?:\\?\/\\?\/[A-Za-z0-9._-]*gne\.go\.kr[^'"\s)]+/i);
    value = m ? m[0].replace(/\\\//g, '/') : '';
  }
  if (!value) return '';

  try {
    let u = new URL(value, baseUrl);

    if (u.hostname === 'search.gne.go.kr') {
      for (const key of ['url','targetUrl','target','link','href','realUrl','moveUrl']) {
        const nested = u.searchParams.get(key);
        if (!nested) continue;
        try {
          const nu = new URL(decodeURIComponent(nested), baseUrl);
          if (nu.hostname === 'gne.go.kr' || nu.hostname.endsWith('.gne.go.kr')) u = nu;
        } catch (_) {}
      }
    }

    if (u.hostname === 'search.gne.go.kr') return '';
    // 자동검색 결과는 경상남도교육청 '본청 누리집(www.gne.go.kr)'만 사용합니다.
    // 교육지원청/직속기관 등 *.gne.go.kr 하위 사이트는 이 검색에서 제외합니다.
    if (!(u.hostname === 'www.gne.go.kr' || u.hostname === 'gne.go.kr')) return '';
    if (u.hostname === 'gne.go.kr') u.hostname = 'www.gne.go.kr';
    u.hash = '';
    return u.href;
  } catch (_) {
    return '';
  }
}

function officialResultType(url) {
  const u = String(url || '');
  if (/\/pr\/user\/bbs\/BD_selectBbs/i.test(u)) return '보도자료';
  if (/businessinfo\.jsp|business[_-]?info|biz[_-]?info/i.test(u)) return '사업안내';
  if (/\/user\/bbs\/BD_selectBbs/i.test(u)) return '게시자료';
  if (/deptBsnsAsgn|bu\d+_organ|업무분장/i.test(u)) return '업무분장';
  if (/\/www\/buseo|bu\d+_info/i.test(u)) return '부서안내';
  if (/\.pdf(?:\?|$)|\.hwp[x]?(?:\?|$)|\.docx?(?:\?|$)|\.xlsx?(?:\?|$)/i.test(u)) return '첨부자료';
  return '공식페이지';
}

function isBusinessGuideResult(result) {
  if (!result) return false;
  const title = compactText(result.title || '');
  const url = String(result.url || '');
  return result.type === '사업안내'
    || title === '사업안내'
    || title.endsWith('사업안내')
    || /businessinfo\.jsp|business[_-]?info|biz[_-]?info/i.test(url);
}

function deriveDepartmentHomepageUrl(results, department = '') {
  const rows = Array.isArray(results) ? results : [];
  const deptKey = compactText(department || '');

  // 관련 부서가 확인된 경우 그 부서명이 제목/검색문맥에 들어 있는 본청 부서 페이지를 우선합니다.
  if (deptKey) {
    const relatedRows = rows.filter(r => {
      if (!r) return false;
      const blob = compactText(`${r.title || ''} ${r.snippet || ''} ${r.url || ''}`);
      return blob.includes(deptKey);
    });

    const exactRelated = relatedRows.find(r => r.type === '부서안내' && /bu\d+_info\.jsp/i.test(String(r.url || '')));
    if (exactRelated) return exactRelated.url;

    for (const r of relatedRows) {
      const m = String(r.url || '').match(/https:\/\/www\.gne\.go\.kr\/www\/buseo(\d+)\//i);
      if (!m) continue;
      const no = m[1];
      return `https://www.gne.go.kr/www/buseo${no}/bu${no}_info.jsp`;
    }
  }

  // 관련 부서명을 검색결과 문맥에서 직접 찾지 못했을 때의 기존 보조 로직입니다.
  const exact = rows.find(r => r && r.type === '부서안내' && /bu\d+_info\.jsp/i.test(String(r.url || '')));
  if (exact) return exact.url;

  for (const r of rows) {
    const m = String(r && r.url || '').match(/https:\/\/www\.gne\.go\.kr\/www\/buseo(\d+)\//i);
    if (!m) continue;
    const no = m[1];
    return `https://www.gne.go.kr/www/buseo${no}/bu${no}_info.jsp`;
  }
  return '';
}

function cleanOfficialSearchSnippet(text, title) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  if (title) value = value.replace(String(title), ' ');
  value = value
    .replace(/통합검색|검색결과|검색어|상세보기|새창열림|바로가기/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length > 220) value = value.slice(0, 219).trimEnd() + '…';
  return value;
}

function parseGneOfficialSearchResults(html, query) {
  const source = String(html || '');
  const queryCore = compactText(query);
  const tokens = (String(query || '').match(/[가-힣A-Za-z0-9]+/g) || []).map(compactText).filter(t => t.length >= 2);
  const candidates = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let am;
  let order = 0;

  while ((am = anchorRe.exec(source)) !== null) {
    const attrs = parseHtmlAttrs(am[1]);
    const title = htmlFragmentToText(am[2]).replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2 || title.length > 180) continue;
    if (/^(홈|HOME|통합검색|전체메뉴|로그인|검색|초기화|더보기|이전|다음|TOP)$/i.test(title)) continue;

    let url = officialGneUrlFromRaw(attrs.href || attrs['data-url'] || attrs['data-href'] || '', GNE_OFFICIAL_SEARCH_URL);
    if (!url) {
      const attrText = `${am[1]} ${attrs.onclick || ''}`;
      const m = attrText.match(/https?:\\?\/\\?\/[A-Za-z0-9._-]*gne\.go\.kr[^'"\s)<>]+/i);
      if (m) url = officialGneUrlFromRaw(m[0].replace(/\\\//g, '/'), GNE_OFFICIAL_SEARCH_URL);
      if (!url) {
        const rel = attrText.match(/["'](\/(?:www|user|pr|works|common)\/[^"']+(?:\.do|\.jsp)(?:\?[^"']*)?)["']/i);
        if (rel) url = officialGneUrlFromRaw(rel[1], 'https://www.gne.go.kr/');
      }
    }
    if (!url) continue;

    const start = Math.max(0, am.index - 420);
    const end = Math.min(source.length, anchorRe.lastIndex + 900);
    const context = htmlFragmentToText(source.slice(start, end));
    const snippet = cleanOfficialSearchSnippet(context, title);
    const titleC = compactText(title);
    const snippetC = compactText(snippet);

    let score = Math.max(0, 400 - order);
    if (queryCore && titleC.includes(queryCore)) score += 300;
    if (queryCore && snippetC.includes(queryCore)) score += 100;
    let titleTokenHits = 0;
    let snippetTokenHits = 0;
    for (const token of tokens) {
      if (titleC.includes(token)) { score += 70; titleTokenHits++; }
      else if (snippetC.includes(token)) { score += 20; snippetTokenHits++; }
    }
    if (tokens.length && titleTokenHits === tokens.length) score += 130;
    if (!titleTokenHits && !snippetTokenHits && queryCore && !titleC.includes(queryCore) && !snippetC.includes(queryCore)) continue;

    let type = officialResultType(url);
    // 보도자료는 민원 안내 자동검색 결과에서 완전히 제외합니다.
    if (type === '보도자료' || /\/pr\//i.test(url)) continue;
    if (/사업\s*안내/.test(title)) type = '사업안내';

    // 사업안내 페이지가 존재하면 항상 최상단에 오도록 강하게 우선합니다.
    if (type === '사업안내') score += 1500;
    else if (type === '부서안내') score += 220;
    else if (type === '업무분장') score += 80;
    else if (type === '게시자료') score += 40;

    const dateMatch = context.match(/20\d{2}[.\/-]\s*\d{1,2}[.\/-]\s*\d{1,2}/);
    const date = dateMatch ? dateMatch[0].replace(/\s+/g, '') : '';
    candidates.push({ title, url, snippet, date, type, score, order: order++ });
  }

  const unique = new Map();
  candidates.sort((a,b) => b.score - a.score || a.order - b.order).forEach(row => {
    const key = `${row.url}|${compactText(row.title)}`;
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()].slice(0, GNE_OFFICIAL_SEARCH_MAX_RESULTS);
}

function getFreshOfficialSearchCache(query) {
  const key = compactText(query);
  const item = GNE_OFFICIAL_SEARCH_QUERY_CACHE.get(key);
  if (!item) return null;
  if (Date.now() - item.updatedAt > GNE_OFFICIAL_SEARCH_QUERY_TTL_MS) {
    GNE_OFFICIAL_SEARCH_QUERY_CACHE.delete(key);
    return null;
  }
  return item.data;
}

function saveOfficialSearchCache(query, data) {
  const key = compactText(query);
  GNE_OFFICIAL_SEARCH_QUERY_CACHE.set(key, { updatedAt: Date.now(), data });
  return data;
}

function officialSearchQueryVariants(query) {
  const normal = String(query || '').replace(/\s+/g, ' ').trim();
  if (!normal) return [];
  // 띄어쓰기 유무와 관계없이 같은 사업명을 찾도록 붙여쓴 검색어도 함께 조회합니다.
  const compact = normal.replace(/\s+/g, '');
  return [...new Set([normal, compact].filter(q => q && q.length >= 2))];
}

async function searchGneOfficialSite(rawQuery) {
  const query = officialSearchCore(rawQuery);
  if (!query) return { query: '', results: [] };
  const cached = getFreshOfficialSearchCache(query);
  if (cached) return cached;

  try {
    const variants = officialSearchQueryVariants(query);
    const fetched = await Promise.allSettled(
      variants.map(q => fetchGneOfficialSearchHtml(q, 2400).then(x => ({ ...x, variant: q })))
    );

    const merged = [];
    let searchUrl = '';
    for (const item of fetched) {
      if (item.status !== 'fulfilled') continue;
      searchUrl = searchUrl || item.value.searchUrl || '';
      merged.push(...parseGneOfficialSearchResults(item.value.html, query));
    }

    const uniq = new Map();
    merged
      .filter(r => r && r.type !== '보도자료' && !/\/pr\//i.test(String(r.url || '')))
      .sort((a,b) => {
        const ab = isBusinessGuideResult(a) ? 1 : 0;
        const bb = isBusinessGuideResult(b) ? 1 : 0;
        return bb - ab || (b.score || 0) - (a.score || 0) || (a.order || 0) - (b.order || 0);
      })
      .forEach(r => {
        const key = `${r.url}|${compactText(r.title || '')}`;
        if (!uniq.has(key)) uniq.set(key, r);
      });

    const results = [...uniq.values()].slice(0, GNE_OFFICIAL_SEARCH_MAX_RESULTS);
    return saveOfficialSearchCache(query, { query, results, searchUrl, source: '경상남도교육청 본청 누리집 통합검색' });
  } catch (err) {
    console.error('경남교육청 공식 누리집 자동검색 오류:', err && err.message ? err.message : err);
    return { query, results: [], error: true };
  }
}

function extractOfficialPageExcerpt(html, title, query) {
  let text = htmlFragmentToText(html);
  if (!text) return '';
  const titleText = String(title || '').trim();
  let start = titleText ? text.indexOf(titleText) : -1;
  if (start >= 0) start += titleText.length;
  else {
    const q = String(query || '').trim();
    start = q ? text.indexOf(q) : -1;
    if (start < 0) start = 0;
  }

  let segment = text.slice(Math.max(0, start), Math.max(0, start) + 1800)
    .replace(/등록자명\s+[^\s]+/g, ' ')
    .replace(/등록일시\s+20\d{2}[-./]\d{1,2}[-./]\d{1,2}/g, ' ')
    .replace(/조회수\s+\d+/g, ' ')
    .replace(/첨부파일|이전글|다음글|목록|담당자 정보|TOP/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (segment.length < 30) return '';
  if (segment.length > 330) segment = segment.slice(0, 329).trimEnd() + '…';
  return segment;
}

async function fetchOfficialPageExcerpt(result, query) {
  if (!result || !result.url) return '';
  if (!['사업안내','게시자료','공식페이지'].includes(result.type)) return '';
  try {
    const html = await fetchOfficialGneHtml(result.url, 950);
    return extractOfficialPageExcerpt(html, result.title, query);
  } catch (_) {
    return '';
  }
}

function searchCachedGneHqContactsOnly(query) {
  const core = normalizeHqContactSearchQuery(query);
  if (!core) return [];
  let rows = [];
  if (GNE_HQ_ALL_CONTACTS_CACHE && Array.isArray(GNE_HQ_ALL_CONTACTS_CACHE.rows)) {
    rows = GNE_HQ_ALL_CONTACTS_CACHE.rows;
  } else {
    const persisted = loadPersistedHqContacts();
    if (persisted && Array.isArray(persisted.rows)) rows = persisted.rows;
  }
  if (!rows.length) return [];
  let ranked = rankHqContactRows(core, rows);
  if (!ranked.length) {
    for (const fallback of hqContactFallbackQueries(core)) {
      ranked = rankHqContactRows(fallback, rows);
      if (ranked.length) break;
    }
  }
  return ranked;
}

function officialContactKeywordTokens(query) {
  const core = officialSearchCore(query);
  return (String(core || '').match(/[가-힣A-Za-z0-9]+/g) || [])
    .map(x => compactText(x))
    .filter(x => x.length >= 2 && !/^(관련|업무|문의|담당|안내|정보|자료|사업|추진|운영|지원)$/.test(x));
}

function contactDutyMatchesOfficialKeyword(query, row) {
  const duty = compactText(row && row.duty || '');
  if (!duty) return false;
  const core = compactText(officialSearchCore(query));
  if (core.length >= 2 && duty.includes(core)) return true;

  const tokens = officialContactKeywordTokens(query);
  if (!tokens.length) return false;
  // 여러 단어 검색은 해당 핵심어가 담당업무 문장 안에 모두 있을 때만 인정합니다.
  if (tokens.length >= 2) return tokens.every(t => duty.includes(t));
  return duty.includes(tokens[0]);
}

function summarizeRelatedDepartmentFromContacts(query, contacts) {
  if (!Array.isArray(contacts) || !contacts.length) return null;

  // '과 전체 업무'를 보여주지 않고 검색 핵심어가 실제 담당업무 문장에 들어 있는 행만 남깁니다.
  let exactRows = contacts.filter(row => contactDutyMatchesOfficialKeyword(query, row));
  if (!exactRows.length) return null;

  const deptCounts = new Map();
  exactRows.forEach(row => {
    const dept = String(row.department || '').trim();
    if (!dept) return;
    if (!deptCounts.has(dept)) deptCounts.set(dept, []);
    deptCounts.get(dept).push(row);
  });
  if (!deptCounts.size) return null;

  // 검색 순위가 이미 관련도순이므로 동률이면 먼저 나온 부서를 우선합니다.
  const ranked = [...deptCounts.entries()].sort((a,b) => b[1].length - a[1].length);
  const [department, deptRows] = ranked[0];

  const seen = new Set();
  const duties = [];
  for (const row of deptRows) {
    const duty = truncateOfficialDuty(row.duty || '', 150);
    const phone = normalizeHqPhone(row.phone || '');
    const team = String(row.team || '').trim();
    const key = `${compactText(duty)}|${phone}`;
    if (!duty || seen.has(key)) continue;
    seen.add(key);
    duties.push({ duty, phone, team });
    if (duties.length >= 3) break;
  }
  return duties.length ? { department, duties, query } : null;
}

async function buildGneOfficialSearchResponse(rawQuery) {
  const search = await searchGneOfficialSite(rawQuery);
  if (!search.results || !search.results.length) return null;

  let related = null;
  try {
    const contactQuery = search.query || officialSearchCore(rawQuery);
    const contacts = searchCachedGneHqContactsOnly(contactQuery);
    related = summarizeRelatedDepartmentFromContacts(contactQuery, contacts);
  } catch (_) {}

  // 관련 부서가 확인되면 대표 링크는 항상 '담당부서 누리집'으로 통일합니다.
  // 관련 부서를 찾지 못한 경우에만 사업안내 페이지를 우선합니다.
  const businessGuide = search.results.find(isBusinessGuideResult) || null;
  const departmentHomepageUrl = deriveDepartmentHomepageUrl(search.results, related && related.department ? related.department : '');
  const primaryResult = search.results[0];

  const lines = [`🔎 '${search.query}' 관련 본청 정보를 찾았어요.`];
  if (related && related.department) {
    lines.push('', `관련 부서: ${related.department}`);
    lines.push('관련 업무:');
    related.duties.forEach(item => {
      lines.push(`• ${item.duty}`);
      if (item.phone) lines.push(`  ☎ ${item.phone}`);
    });
  } else {
    lines.push('', '관련 부서·담당업무는 본청 업무분장에서 검색어가 직접 포함된 항목을 확인하지 못했어요.');
    lines.push('아래 업무담당자 검색을 눌러 업무명을 조금 더 구체적으로 확인해 주세요.');
  }
  lines.push('', '※ 경상남도교육청 본청 누리집과 본청 업무분장 정보만 확인합니다.');

  const text = lines.join('\n').slice(0, 980);
  const buttons = [];

  if (related && related.department && departmentHomepageUrl) {
    buttons.push({ label: '🏢 담당부서 누리집', action: 'webLink', webLinkUrl: departmentHomepageUrl });
  } else if (businessGuide && businessGuide.url) {
    buttons.push({ label: '📌 사업안내', action: 'webLink', webLinkUrl: businessGuide.url });
  } else if (departmentHomepageUrl) {
    buttons.push({ label: '🏢 담당부서 누리집', action: 'webLink', webLinkUrl: departmentHomepageUrl });
  } else if (primaryResult && primaryResult.url) {
    buttons.push({ label: '🏢 관련 부서 확인', action: 'webLink', webLinkUrl: primaryResult.url });
  }

  const outputs = [{ simpleText: { text } }];
  if (buttons.length) {
    outputs.push({
      basicCard: {
        title: related && related.department ? related.department : '경남교육청 본청 안내',
        description: (related && related.department && departmentHomepageUrl)
          ? '관련 부서가 확인되어 담당부서 누리집을 연결합니다.'
          : (businessGuide
            ? '사업안내 페이지를 연결합니다.'
            : (departmentHomepageUrl ? '담당부서 누리집을 연결합니다.' : '관련 본청 페이지를 확인할 수 있어요.')),
        buttons
      }
    });
  }

  // 카카오 노란색 바로연결 버튼으로 표시하고, 클릭 시 같은 검색어로 담당자를 바로 조회합니다.
  const quickReplies = [{
    label: '🔎 업무담당자 검색',
    action: 'message',
    messageText: `${search.query} 담당자`
  }];

  return {
    version: '2.0',
    template: { outputs, quickReplies },
    meta: { query: search.query, relatedDepartment: related && related.department ? related.department : '', results: search.results }
  };
}

async function warmGneOfficialSearchForm() {
  try {
    await getGneOfficialSearchForm();
    console.log('✅ 경남교육청 공식 통합검색 폼 캐시 준비 완료');
  } catch (err) {
    console.error('경남교육청 공식 통합검색 폼 사전준비 오류:', err && err.message ? err.message : err);
  }
}

// 브라우저에서 공식 누리집 자동검색이 실제로 동작하는지 확인하는 테스트 API
// 예: /api/official-search?query=유보통합%20추진%20안내
app.get('/api/official-search', async (req, res) => {
  const query = String((req.query && req.query.query) || '').trim();
  if (!query) return res.status(400).json({ ok: false, message: '검색어를 입력해 주세요.' });
  const result = await searchGneOfficialSite(query);
  return res.json({ ok: true, ...result, count: (result.results || []).length });
});

// ---- 카카오톡 오픈빌더 폴백 스킬 웹훅 ----
// 1) 제목/등록발화와 매우 명확하게 일치하는 짧은 질문 -> 기존 고정답변
// 2) 자연어·복합질문·후속질문 -> 관련 자료 여러 개 검색 -> 생성형 AI가 자료 안에서 답변
// 3) AI 비활성/오류 -> 기존 폴백 + 추천 버튼
app.post('/api/kakao-skill', async (req, res) => {
  const utterance = (req.body && req.body.userRequest && req.body.userRequest.utterance) || '';

  // 이 라우트에서 반환되는 모든 카카오 응답에 질문별 통합안내 버튼을 자동 적용합니다.
  const originalJson = res.json.bind(res);
  res.json = (payload) => originalJson(withGuideQuickReply(payload, utterance));
  const kakaoUserId = (req.body && req.body.userRequest && req.body.userRequest.user && req.body.userRequest.user.id) || '';
  const kakaoInteraction = getKakaoInteractionMeta(req.body || {});
  const blocks = getEffectiveUtterances();

  if (!utterance.trim()) {
    // 스킬이 발화 없이 호출된 경우에도 카카오가 넘긴 블록 흐름은 통계에 남깁니다.
    const blockLabel = kakaoInteraction.currentBlock || kakaoInteraction.lastBlock || kakaoInteraction.referrerBlock || '카카오 블록 호출';
    trackQuery('[블록 호출]', blockLabel, true, 'kakao-block-event', 'kakao:' + kakaoUserId, kakaoInteraction);
    return res.json(withStaffSearchQuickReply(kakaoFallbackResponse('', blocks, { failCount: 0 })));
  }

  // 담당자 메뉴 자체를 누른 경우에는 블록 파라미터나 일반 시나리오 매칭보다 먼저 처리합니다.
  // 예: '담당자(본청) 안내', '담당자 안내', '담당자', '담당', '담당부서', '담당업무'
  if (isHqContactMenuAlias(utterance)) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, '본청 업무담당자 안내', true, 'kakao-hq-contact-menu-alias', 'kakao:' + kakaoUserId, kakaoInteraction);
    return res.json(kakaoHqContactAskResponse());
  }

  // '업무담당자 찾기' 블록에서 @sys.text 파라미터(work)로 받은 검색어는
  // '담당자'라는 단어가 없어도 그대로 본청 업무검색에 사용합니다.
  const hqWorkParam = extractHqWorkParamFromPayload(req.body || {});
  if (hqWorkParam) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, `본청 업무담당자:${hqWorkParam}`, true, 'kakao-live-hq-contact-param', 'kakao:' + kakaoUserId, kakaoInteraction);
    return res.json(withStaffSearchQuickReply(await kakaoHqContactResponse({ query: hqWorkParam })));
  }

  // '공무원 인사', '교원 인사'는 '담당자'라는 단어가 없어도
  // 본청 업무담당자 검색으로 바로 보냅니다.
  // 유사도 기반 시나리오 매칭이 '부패·공익신고' 등 다른 항목을 고르는 것을 방지합니다.
  const implicitPersonnelIntent = detectImplicitPersonnelContactIntent(utterance);
  if (implicitPersonnelIntent) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(
      utterance,
      `본청 업무담당자:${implicitPersonnelIntent.query}`,
      true,
      'kakao-live-hq-personnel-contact',
      'kakao:' + kakaoUserId,
      kakaoInteraction
    );
    return res.json(withStaffSearchQuickReply(await kakaoHqContactResponse(implicitPersonnelIntent)));
  }

  // 전입학 담당자/전화번호 질문은 시나리오 매칭보다 먼저 처리합니다.
  // 경상남도교육청 공식 홈페이지를 실시간 조회하므로 번호를 server.js에 고정하지 않습니다.
  const transferContactIntent = detectTransferContactIntent(utterance);
  if (transferContactIntent) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, '전입학 담당자 실시간 조회', true, 'kakao-live-transfer-contact', 'kakao:' + kakaoUserId, kakaoInteraction);
    return res.json(withStaffSearchQuickReply(await kakaoTransferContactResponse(transferContactIntent)));
  }


  // 그 외 본청 담당자/전화번호 질문은 경남교육청 공식 "업무검색"에서 실시간 조회합니다.
  // 예: 청원 담당자, 정보공개 전화번호, 검정고시 담당자, 학교급식 담당자
  const hqContactIntent = detectHqContactIntent(utterance);
  if (hqContactIntent) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, `본청 업무담당자:${hqContactIntent.query || '업무확인'}`, true, 'kakao-live-hq-contact', 'kakao:' + kakaoUserId, kakaoInteraction);
    return res.json(withStaffSearchQuickReply(await kakaoHqContactResponse(hqContactIntent)));
  }

  // '공사'처럼 계약업무(재정과)와 시설공사업무(시설과)로 나뉘는 표현은
  // 일반 시나리오/공식누리집 검색보다 먼저 분야 선택을 안내합니다.
  // 사용자가 직접 입력했거나 카카오 버튼으로 들어와도 동일하게 처리합니다.
  if (isAmbiguousConstructionQuery(utterance)) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(
      utterance,
      '공사 업무 구분: 재정과 계약 / 시설과 공사',
      true,
      'kakao-clarify-construction',
      'kakao:' + kakaoUserId,
      kakaoInteraction
    );
    return res.json(withStaffSearchQuickReply(await kakaoHqContactResponse({ query: '공사' })));
  }

  // 학교급을 말하지 않은 일반 전학 문의는 억지로 한 블록을 고르지 않고
  // 고등학교/중학교 전입학 두 선택지를 함께 보여줍니다.
  if (needsTransferSchoolLevel(utterance)) {
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, '전입학 학교급 확인', true, 'kakao-clarify-transfer-level', 'kakao:' + kakaoUserId, kakaoInteraction);
    return res.json(withStaffSearchQuickReply(kakaoTransferSchoolLevelResponse(blocks)));
  }

  // API 유무와 관계없이 먼저 안전한 규칙/대표질문/오타 매칭을 시도
  const match = smartMatch(utterance, blocks);
  if (match.matched && match.idx >= 0) {
    const block = blocks[match.idx];
    resetKakaoFailStreak(kakaoUserId);
    resetKakaoTransferFailStreak(kakaoUserId);
    trackQuery(utterance, block.title, true, 'kakao-smart-' + match.reason, 'kakao:' + kakaoUserId, kakaoInteraction);

    const outputs = buildKakaoOutputsFromScenarioBlock(block);

    const quickReplies = buildBlockQuickReplies(block, blocks);
    const assistantSummary = (block.responses || []).map(r => r.message || '').join('\n').slice(0, 1200);
    rememberTurn(kakaoUserId, utterance, assistantSummary);
    return res.json(withStaffSearchQuickReply({ version: '2.0', template: { outputs, quickReplies } }));
  }

  // 시나리오에서 답을 찾지 못한 정책/사업/제도 질문은 경남교육청 공식 통합검색으로 보완합니다.
  // 유료 생성형 AI 없이 공식 누리집 결과만 사용하며, 검색 실패 시 기존 폴백으로 그대로 이어집니다.
  if (shouldTryOfficialGneSearch(utterance)) {
    try {
      const officialResponse = await buildGneOfficialSearchResponse(utterance);
      if (officialResponse) {
        resetKakaoFailStreak(kakaoUserId);
        resetKakaoTransferFailStreak(kakaoUserId);
        const officialTitle = officialResponse.meta && officialResponse.meta.results && officialResponse.meta.results[0]
          ? officialResponse.meta.results[0].title : '경남교육청 공식 누리집 검색';
        trackQuery(utterance, `공식누리집:${officialTitle}`, true, 'kakao-gne-official-search', 'kakao:' + kakaoUserId, kakaoInteraction);
        const safe = { version: officialResponse.version, template: officialResponse.template };
        return res.json(withStaffSearchQuickReply(safe));
      }
    } catch (err) {
      console.error('카카오 공식 누리집 자동검색 처리 오류:', err && err.message ? err.message : err);
    }
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
    trackQuery(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', false, 'kakao-no-ai-ambiguous', 'kakao:' + kakaoUserId, kakaoInteraction);
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
    trackQuery(utterance, candidateTitle ? `AI:${candidateTitle}` : 'AI', true, 'kakao-ai', 'kakao:' + kakaoUserId, kakaoInteraction);
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
    trackQuery(utterance, bestCandidate ? blocks[bestCandidate.idx].title : '', false, 'kakao-ai-error', 'kakao:' + kakaoUserId, kakaoInteraction);
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
  const filteredMissed = filterByKstPeriod(readJson(MISSED_PATH, []), req.query);
  const summary = getMissedSummary(filteredMissed);
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
  const summary = getMissedSummary(filterByKstPeriod(readJson(MISSED_PATH, []), req.query));
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

// 통계 날짜는 한국시간(KST) 기준으로 집계합니다.
// 질문 저장 시간은 ISO(UTC)라서 단순히 앞 10자리를 자르면 자정 전후 통계가 하루씩 어긋날 수 있습니다.
function toKstDateKey(isoTime) {
  if (!isoTime) return '';
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return '';
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toKstDateTimeParts(isoTime) {
  if (!isoTime) return { date: '', time: '', dateTime: '' };
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return { date: '', time: '', dateTime: '' };
  const kst = new Date(t + 9 * 60 * 60 * 1000).toISOString();
  const date = kst.slice(0, 10);
  const time = kst.slice(11, 19);
  return { date, time, dateTime: `${date} ${time}` };
}

function normalizeAdminDate(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function getAdminPeriod(query = {}) {
  let from = normalizeAdminDate(query.from || '');
  let to = normalizeAdminDate(query.to || '');
  const legacyDate = normalizeAdminDate(query.date || '');
  if (legacyDate) {
    from = legacyDate;
    to = legacyDate;
  }
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

function filterByKstPeriod(list, query = {}) {
  const { from, to } = getAdminPeriod(query);
  if (!from && !to) return Array.isArray(list) ? [...list] : [];
  return (Array.isArray(list) ? list : []).filter(e => {
    const d = toKstDateKey(e && e.time);
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

function periodLabel(query = {}) {
  const { from, to } = getAdminPeriod(query);
  if (from && to) return from === to ? from : `${from} ~ ${to}`;
  if (from) return `${from} ~`;
  if (to) return `~ ${to}`;
  return '전체 기간';
}

function buildDailyStats(list, limit) {
  const byDay = {};
  (list || []).forEach(e => {
    const d = toKstDateKey(e.time);
    if (!d) return;
    if (!byDay[d]) {
      byDay[d] = {
        date: d,
        total: 0,
        matchedCount: 0,
        unmatchedCount: 0,
        directInputCount: 0,
        buttonClickCount: 0,
        visitors: new Set()
      };
    }
    const g = byDay[d];
    g.total += 1;
    if (e.matched) g.matchedCount += 1;
    else g.unmatchedCount += 1;
    if (e.inputType === '직접입력') g.directInputCount += 1;
    if (e.inputType === '버튼클릭') g.buttonClickCount += 1;
    if (e.visitorId) g.visitors.add(e.visitorId);
  });

  let keys = Object.keys(byDay).sort();
  if (limit && Number(limit) > 0) keys = keys.slice(-Number(limit));
  return keys.reverse().map(d => {
    const g = byDay[d];
    return {
      date: d,
      total: g.total,
      matchedCount: g.matchedCount,
      unmatchedCount: g.unmatchedCount,
      matchRate: g.total ? Number((g.matchedCount / g.total * 100).toFixed(1)) : 0,
      uniqueVisitors: g.visitors.size,
      directInputCount: g.directInputCount,
      buttonClickCount: g.buttonClickCount
    };
  });
}

// 사용 통계: 인기 질문, 일별 추이, 매칭 성공률, 순방문자
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const allList = readJson(QUERIES_PATH, []);
  const list = filterByKstPeriod(allList, req.query);
  const total = list.length;
  const matchedCount = list.filter(e => e.matched).length;

  const byTitle = {};
  list.forEach(e => { if (e.matched && e.matchedTitle) byTitle[e.matchedTitle] = (byTitle[e.matchedTitle]||0)+1; });
  const topBlocks = Object.entries(byTitle).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([title,count])=>({title,count}));

  // 선택한 조회기간의 일별 통계를 모두 보여줍니다.
  // 질문이 한 건도 없었던 날은 행을 만들지 않습니다.
  const days = buildDailyStats(list, 0);

  const bySource = {};
  list.forEach(e => { const s = e.source||'unknown'; bySource[s] = (bySource[s]||0)+1; });

  const byInputType = {};
  list.forEach(e => {
    const t = e.inputType || '기록없음';
    byInputType[t] = (byInputType[t] || 0) + 1;
  });
  const buttonCounts = {};
  list.forEach(e => {
    if (e.inputType !== '버튼클릭') return;
    const label = String(e.buttonText || e.query || '').trim() || '(버튼명 확인 불가)';
    buttonCounts[label] = (buttonCounts[label] || 0) + 1;
  });
  const topButtons = Object.entries(buttonCounts)
    .sort((a,b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko'))
    .map(([label,count]) => ({ label, count }));

  // Render가 실제로 받은 스킬 payload 안의 블록 흐름을 최대한 기록합니다.
  // currentBlock은 스킬이 실행된 블록, referrerBlock은 버튼 등을 누른 출발 블록,
  // lastBlock은 직전에 실행된 블록입니다. 카카오 내부에서만 이동하고 스킬을 호출하지 않은 블록은 Render가 직접 볼 수 없습니다.
  const blockFlowMap = new Map();
  const touchBlock = (name, kind) => {
    const n = String(name || '').trim();
    if (!n) return;
    if (!blockFlowMap.has(n)) blockFlowMap.set(n, { name: n, current: 0, referrer: 0, last: 0 });
    blockFlowMap.get(n)[kind] += 1;
  };
  list.forEach(e => {
    touchBlock(e.currentBlock, 'current');
    touchBlock(e.referrerBlock, 'referrer');
    touchBlock(e.lastBlock, 'last');
  });
  const blockFlows = [...blockFlowMap.values()]
    .sort((a,b) => (b.current+b.referrer+b.last) - (a.current+a.referrer+a.last) || String(a.name).localeCompare(String(b.name), 'ko'));

  const allVisitorIds = new Set(list.map(e => e.visitorId).filter(Boolean));
  const visitorQueryCounts = {};
  list.forEach(e => { if (e.visitorId) visitorQueryCounts[e.visitorId] = (visitorQueryCounts[e.visitorId]||0)+1; });
  const avgQueriesPerVisitor = allVisitorIds.size ? Number((total/allVisitorIds.size).toFixed(1)) : 0;

  res.json({
    total, matchedCount, unmatchedCount: total - matchedCount,
    matchRate: total ? Number((matchedCount/total*100).toFixed(1)) : 0,
    uniqueVisitors: allVisitorIds.size, avgQueriesPerVisitor,
    topBlocks, days, bySource, byInputType, topButtons, blockFlows,
    storage: SUPABASE_ENABLED ? 'supabase' : 'local',
    period: { ...getAdminPeriod(req.query), label: periodLabel(req.query) }
  });
});

// 카드 하나 분량만 엑셀 한 시트로 내려받습니다. section 값으로 어떤 카드인지 지정합니다.
function sendXlsxSheet(res, sheetName, rows, filenamePrefix, period) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 안내: '해당 조건에 데이터가 없습니다.' }]);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = filenamePrefix + '_' + (period.from || '전체') + '_' + (period.to || '전체') + '.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
  res.send(buf);
}

app.get('/api/admin/export-section.xlsx', requireAdmin, (req, res) => {
  const type = String(req.query.type || '').trim();
  const period = getAdminPeriod(req.query);
  const allList = readJson(QUERIES_PATH, []);
  const list = filterByKstPeriod(allList, req.query);

  if (type === 'buttons') {
    const buttonCounts = {};
    list.forEach(e => {
      if (e.inputType !== '버튼클릭') return;
      const label = String(e.buttonText || e.query || '').trim() || '(버튼명 확인 불가)';
      buttonCounts[label] = (buttonCounts[label] || 0) + 1;
    });
    const rows = Object.entries(buttonCounts)
      .sort((a,b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ko'))
      .map(([label,count]) => ({ 버튼문구: label, 클릭횟수: count }));
    return sendXlsxSheet(res, '입력방식_버튼이용', rows, '입력방식_버튼이용', period);
  }

  if (type === 'blockFlow') {
    const blockFlowMap = new Map();
    const touchBlock = (name, kind) => {
      const n = String(name || '').trim();
      if (!n) return;
      if (!blockFlowMap.has(n)) blockFlowMap.set(n, { name: n, current: 0, referrer: 0, last: 0 });
      blockFlowMap.get(n)[kind] += 1;
    };
    list.forEach(e => {
      touchBlock(e.currentBlock, 'current');
      touchBlock(e.referrerBlock, 'referrer');
      touchBlock(e.lastBlock, 'last');
    });
    const rows = [...blockFlowMap.values()]
      .sort((a,b) => (b.current+b.referrer+b.last) - (a.current+a.referrer+a.last) || String(a.name).localeCompare(String(b.name), 'ko'))
      .map(b => ({ 블록명: b.name, 현재스킬블록: b.current, 버튼출발블록: b.referrer, 직전블록: b.last }));
    return sendXlsxSheet(res, '카카오블록흐름', rows, '카카오블록흐름', period);
  }

  if (type === 'sessionPaths') {
    const byVisitorEntries = new Map();
    list.forEach(e => {
      const visitorId = String(e.visitorId || '').trim();
      if (!visitorId) return;
      const t = new Date(e.time).getTime();
      if (!Number.isFinite(t)) return;
      if (!byVisitorEntries.has(visitorId)) byVisitorEntries.set(visitorId, []);
      byVisitorEntries.get(visitorId).push({ t, dateTime: toKstDateTimeParts(e.time).dateTime, block: e.currentBlock || e.matchedTitle || '', query: e.query || e.buttonText || '' });
    });
    const rows = [];
    byVisitorEntries.forEach((entries, visitorId) => {
      entries.sort((a, b) => a.t - b.t);
      let session = [];
      let sessionNo = 0;
      const flush = () => {
        if (session.length >= 2) {
          sessionNo += 1;
          session.forEach((s, i) => {
            rows.push({ 방문자: maskVisitorId(visitorId), 세션번호: sessionNo, 순서: i + 1, 시간: s.dateTime, 블록: s.block || s.query || '(블록 미상)' });
          });
        }
        session = [];
      };
      entries.forEach(e => {
        if (session.length && (e.t - session[session.length - 1].t) > SESSION_GAP_MS) flush();
        session.push(e);
      });
      flush();
    });
    return sendXlsxSheet(res, '세션별이동경로', rows, '세션별이동경로', period);
  }

  if (type === 'visitors') {
    const byVisitor = new Map();
    list.forEach(e => {
      const visitorId = String(e.visitorId || '').trim();
      if (!visitorId) return;
      const dt = toKstDateTimeParts(e.time);
      const t = new Date(e.time).getTime();
      if (!Number.isFinite(t)) return;
      if (!byVisitor.has(visitorId)) byVisitor.set(visitorId, { total: 0, matched: 0, firstT: t, lastT: t, dates: new Set(), topics: new Map() });
      const v = byVisitor.get(visitorId);
      v.total += 1;
      if (e.matched) v.matched += 1;
      if (t < v.firstT) v.firstT = t;
      if (t > v.lastT) v.lastT = t;
      v.dates.add(dt.date);
      const topic = String(e.currentBlock || e.matchedTitle || '').trim();
      if (topic) v.topics.set(topic, (v.topics.get(topic) || 0) + 1);
    });
    const rows = Array.from(byVisitor.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({
        방문자: maskVisitorId(id), 총질문수: v.total,
        매칭률: v.total ? Math.round((v.matched / v.total) * 100) : 0,
        활동일수: v.dates.size,
        첫이용: toKstDateTimeParts(new Date(v.firstT).toISOString()).dateTime,
        마지막이용: toKstDateTimeParts(new Date(v.lastT).toISOString()).dateTime,
        자주물어본항목: Array.from(v.topics.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => n + '(' + c + ')').join(', ')
      }));
    return sendXlsxSheet(res, '방문자별이용현황', rows, '방문자별이용현황', period);
  }

  if (type === 'learned') {
    const learnedAll = readJson(LEARNED_PATH, []);
    const rows = learnedAll.map(e => ({ 등록한문장: e.text || '', 연결된항목: e.blockTitle || '' }));
    return sendXlsxSheet(res, '학습된표현', rows, '학습된표현', period);
  }

  if (type === 'daily') {
    const rows = buildDailyStats(list, 0).map(d => ({
      일자: d.date, 질문수: d.total, 순방문자: d.uniqueVisitors,
      매칭: d.matchedCount, 미매칭: d.unmatchedCount,
      직접입력: d.directInputCount, 버튼클릭: d.buttonClickCount, '매칭률(%)': d.matchRate
    }));
    return sendXlsxSheet(res, '조회기간일별통계', rows, '조회기간일별통계', period);
  }

  if (type === 'questionsAll') {
    const q = String(req.query.q || '').trim().toLowerCase();
    let rows = allList.map((e, idx) => {
      const dt = toKstDateTimeParts(e.time);
      return { idx, date: dt.date, time: dt.time, ...e };
    });
    if (period.from) rows = rows.filter(r => r.date >= period.from);
    if (period.to) rows = rows.filter(r => r.date <= period.to);
    if (q) rows = rows.filter(r => (`${r.query} ${r.matchedTitle} ${r.referrerBlock} ${r.currentBlock} ${r.lastBlock}`).toLowerCase().includes(q));
    rows.sort((a, b) => b.idx - a.idx);
    const outRows = rows.map(r => ({
      '일자(KST)': r.date, '시간(KST)': r.time, 질문: r.query || '', 결과: r.matched ? '매칭' : '미매칭',
      연결항목: r.matchedTitle || '', 입력유형: r.inputType || '기록없음', 버튼내용: r.buttonText || '',
      버튼출발블록: r.referrerBlock || '', 현재스킬블록: r.currentBlock || '', 직전블록: r.lastBlock || '',
      'Trigger Type': r.triggerType || '', 유입경로: r.source || ''
    }));
    return sendXlsxSheet(res, '전체질문내역', outRows, '전체질문내역', period);
  }

  if (type === 'missedSummary') {
    const summary = getMissedSummary(filterByKstPeriod(readJson(MISSED_PATH, []), req.query));
    const rows = summary.map(s => ({
      질문: s.sample, 횟수: s.count, 추정항목: s.bestGuessTitle || '', 추정점수: s.bestGuessScore ?? '',
      학습됨: s.alreadyLearned ? 'Y' : 'N', 최초발생: s.firstSeen || '', 최근발생: s.lastSeen || ''
    }));
    return sendXlsxSheet(res, '놓친질문요약', rows, '놓친질문요약', period);
  }

  if (type === 'missedDetail') {
    const q = String(req.query.q || '').trim().toLowerCase();
    let rows = readJson(MISSED_PATH, []).map((e, idx) => {
      const dt = toKstDateTimeParts(e.time);
      return { idx, date: dt.date, time: dt.time, query: e.query || '', bestGuessTitle: e.bestGuessTitle || '', bestGuessScore: e.bestGuessScore ?? '' };
    });
    if (period.from) rows = rows.filter(r => r.date >= period.from);
    if (period.to) rows = rows.filter(r => r.date <= period.to);
    if (q) rows = rows.filter(r => (`${r.query} ${r.bestGuessTitle}`).toLowerCase().includes(q));
    rows.sort((a, b) => b.idx - a.idx);
    const outRows = rows.map(r => ({ '일자(KST)': r.date, '시간(KST)': r.time, 놓친질문: r.query, 추정항목: r.bestGuessTitle, 추정점수: r.bestGuessScore }));
    return sendXlsxSheet(res, '놓친질문일별', outRows, '놓친질문일별', period);
  }

  res.status(400).json({ error: 'type 파라미터가 올바르지 않습니다. (buttons/blockFlow/sessionPaths/visitors/learned/daily/questionsAll/missedSummary/missedDetail)' });
});
app.delete('/api/admin/stats', requireAdmin, (req, res) => {
  writeJson(QUERIES_PATH, []);
  res.json({ status: 'ok' });
});



// 전체 질문에서 한 건 삭제
app.delete('/api/admin/questions/:i', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  const i = Number(req.params.i);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    return res.status(404).json({ error: '삭제할 질문을 찾지 못했습니다.' });
  }
  const [removed] = list.splice(i, 1);
  writeJson(QUERIES_PATH, list);
  res.json({ status: 'ok', removed: 1, item: removed || null });
});

// 지정 기간의 전체 질문 삭제. 기간을 반드시 지정해야 전체 실수 삭제를 방지합니다.
app.delete('/api/admin/questions', requireAdmin, (req, res) => {
  const { from, to } = getAdminPeriod(req.query);
  if (!from && !to) return res.status(400).json({ error: '삭제할 시작일 또는 종료일을 지정해 주세요.' });
  const list = readJson(QUERIES_PATH, []);
  const kept = list.filter(e => {
    const d = toKstDateKey(e && e.time);
    if (!d) return true;
    if (from && d < from) return true;
    if (to && d > to) return true;
    return false;
  });
  const removed = list.length - kept.length;
  writeJson(QUERIES_PATH, kept);
  res.json({ status: 'ok', removed, period: { from, to } });
});

// 지정 기간의 질문 통계 + 놓친 질문 기록을 함께 삭제 (테스트 기록 정리용)
app.delete('/api/admin/records', requireAdmin, (req, res) => {
  const { from, to } = getAdminPeriod(req.query);
  if (!from && !to) return res.status(400).json({ error: '삭제할 시작일 또는 종료일을 지정해 주세요.' });

  const queries = readJson(QUERIES_PATH, []);
  const keptQueries = queries.filter(e => {
    const d = toKstDateKey(e && e.time);
    if (!d) return true;
    if (from && d < from) return true;
    if (to && d > to) return true;
    return false;
  });

  const missed = readJson(MISSED_PATH, []);
  const keptMissed = missed.filter(e => {
    const d = toKstDateKey(e && e.time);
    if (!d) return true;
    if (from && d < from) return true;
    if (to && d > to) return true;
    return false;
  });

  writeJson(QUERIES_PATH, keptQueries);
  writeJson(MISSED_PATH, keptMissed);
  res.json({
    status: 'ok',
    removedQueries: queries.length - keptQueries.length,
    removedMissed: missed.length - keptMissed.length,
    period: { from, to }
  });
});

// 놓친 질문 원본 한 건 삭제
app.delete('/api/admin/missed-detail/:i', requireAdmin, (req, res) => {
  const list = readJson(MISSED_PATH, []);
  const i = Number(req.params.i);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    return res.status(404).json({ error: '삭제할 놓친 질문을 찾지 못했습니다.' });
  }
  list.splice(i, 1);
  writeJson(MISSED_PATH, list);
  res.json({ status: 'ok', removed: 1 });
});

// 지정 기간의 놓친 질문 원본 삭제
app.delete('/api/admin/missed-detail', requireAdmin, (req, res) => {
  const { from, to } = getAdminPeriod(req.query);
  if (!from && !to) return res.status(400).json({ error: '삭제할 시작일 또는 종료일을 지정해 주세요.' });
  const list = readJson(MISSED_PATH, []);
  const kept = list.filter(e => {
    const d = toKstDateKey(e && e.time);
    if (!d) return true;
    if (from && d < from) return true;
    if (to && d > to) return true;
    return false;
  });
  const removed = list.length - kept.length;
  writeJson(MISSED_PATH, kept);
  res.json({ status: 'ok', removed, period: { from, to } });
});

// 전체 질문 상세 내역: 날짜(KST)·검색어 필터 + 페이지 이동
// 방문자(visitorId)별로 시간순 정렬한 뒤, 30분 이상 공백이 생기면 새 세션으로 나눠서
// "어떤 블록을 타고 이동했는지" 경로를 재구성합니다. 블록 정보가 없는(스킬 미연결) 구간은
// 로그 자체가 없어 경로에서 비어 보일 수 있습니다.
const SESSION_GAP_MS = 30 * 60 * 1000;

app.get('/api/admin/session-paths', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  const period = getAdminPeriod(req.query);
  const minHops = Math.max(Number(req.query.minHops) || 2, 1);

  const byVisitor = new Map();
  list.forEach((e, idx) => {
    const visitorId = String(e.visitorId || '').trim();
    if (!visitorId) return; // 방문자 식별자가 없으면 세션으로 묶을 수 없어 제외합니다.
    const dt = toKstDateTimeParts(e.time);
    if (period.from && dt.date < period.from) return;
    if (period.to && dt.date > period.to) return;
    const t = new Date(e.time).getTime();
    if (!Number.isFinite(t)) return;
    if (!byVisitor.has(visitorId)) byVisitor.set(visitorId, []);
    byVisitor.get(visitorId).push({
      idx, t, dateTime: dt.dateTime,
      block: e.currentBlock || e.matchedTitle || '',
      query: e.query || e.buttonText || '',
      inputType: e.inputType || '',
      matched: !!e.matched
    });
  });

  const sessions = [];
  byVisitor.forEach((entries, visitorId) => {
    entries.sort((a, b) => a.t - b.t);
    let current = [];
    const flush = () => {
      if (current.length >= minHops) {
        sessions.push({
          visitorId: maskVisitorId(visitorId), // 방문자 식별자는 일부만 노출합니다.
          start: current[0].dateTime,
          end: current[current.length - 1].dateTime,
          hops: current.length,
          path: current.map(c => ({ block: c.block, query: c.query, time: c.dateTime, matched: c.matched }))
        });
      }
      current = [];
    };
    entries.forEach(e => {
      if (current.length && (e.t - current[current.length - 1].t) > SESSION_GAP_MS) flush();
      current.push(e);
    });
    flush();
  });

  sessions.sort((a, b) => (a.end < b.end ? 1 : -1));
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 20), 1000);
  res.json({ total: sessions.length, period, sessions: sessions.slice(0, limit) });
});

// 방문자ID별로 총 질문수·매칭률·처음~마지막 이용시각·자주 물어본 항목을 집계합니다.
// 카카오톡 안에서는 사용자ID가 고정되어 잘 잡히지만, 웹 챗봇 등 접속 경로가 다르면
// 같은 사람이라도 별도 방문자ID로 잡혀 하나로 합쳐지지 않을 수 있습니다.
app.get('/api/admin/visitors', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  const period = getAdminPeriod(req.query);
  const q = String(req.query.q || '').trim().toLowerCase();

  const byVisitor = new Map();
  list.forEach(e => {
    const visitorId = String(e.visitorId || '').trim();
    if (!visitorId) return;
    const dt = toKstDateTimeParts(e.time);
    if (period.from && dt.date < period.from) return;
    if (period.to && dt.date > period.to) return;
    const t = new Date(e.time).getTime();
    if (!Number.isFinite(t)) return;

    if (!byVisitor.has(visitorId)) {
      byVisitor.set(visitorId, { visitorId, total: 0, matched: 0, firstT: t, lastT: t, dates: new Set(), topicCounts: new Map() });
    }
    const v = byVisitor.get(visitorId);
    v.total += 1;
    if (e.matched) v.matched += 1;
    if (t < v.firstT) v.firstT = t;
    if (t > v.lastT) v.lastT = t;
    v.dates.add(dt.date);
    const topic = String(e.currentBlock || e.matchedTitle || '').trim();
    if (topic) v.topicCounts.set(topic, (v.topicCounts.get(topic) || 0) + 1);
  });

  let rows = Array.from(byVisitor.values()).map(v => {
    const topTopics = Array.from(v.topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => name + '(' + count + ')');
    return {
      visitorId: maskVisitorId(v.visitorId),
      total: v.total,
      matched: v.matched,
      matchRate: v.total ? Math.round((v.matched / v.total) * 100) : 0,
      activeDays: v.dates.size,
      first: toKstDateTimeParts(new Date(v.firstT).toISOString()).dateTime,
      last: toKstDateTimeParts(new Date(v.lastT).toISOString()).dateTime,
      topTopics: topTopics.join(', ')
    };
  });

  if (q) rows = rows.filter(r => (r.visitorId + ' ' + r.topTopics).toLowerCase().includes(q));
  rows.sort((a, b) => b.total - a.total);

  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 20), 2000);
  res.json({ total: rows.length, period, visitors: rows.slice(0, limit) });
});

// 질문내역·놓친질문·방문자별·세션경로·일별통계·학습된표현을 시트별로 묶어
// 엑셀(xlsx) 파일 하나로 내려받습니다. 조회기간을 지정하면 그 기간만, 지정하지 않으면 전체 기간입니다.
app.get('/api/admin/export-all.xlsx', requireAdmin, (req, res) => {
  const period = getAdminPeriod(req.query);
  const inPeriod = (dateStr) => (!period.from || dateStr >= period.from) && (!period.to || dateStr <= period.to);

  const allQueries = readJson(QUERIES_PATH, []);
  const queries = allQueries.filter(e => inPeriod(toKstDateKey(e.time) || ''));

  // 1) 전체 질문 내역
  const questionRows = queries.map(e => {
    const dt = toKstDateTimeParts(e.time);
    return {
      일자: dt.date, 시간: dt.time, 입력유형: e.inputType || '기록없음',
      '질문/버튼': e.buttonText || e.query || '', 결과: e.matched ? '매칭' : '미매칭',
      연결항목: e.matchedTitle || '', 버튼출발블록: e.referrerBlock || '',
      현재스킬블록: e.currentBlock || '', 직전블록: e.lastBlock || '',
      방문자: maskVisitorId(e.visitorId || '')
    };
  });

  // 2) 놓친 질문 상세
  const missedAll = readJson(MISSED_PATH, []);
  const missedRows = missedAll
    .filter(e => inPeriod(toKstDateKey(e.time) || ''))
    .map(e => {
      const dt = toKstDateTimeParts(e.time);
      return { 일자: dt.date, 시간: dt.time, 놓친질문: e.query || '', 추정항목: e.bestGuessTitle || '', 점수: e.bestGuessScore ?? '' };
    });

  // 3) 방문자별 이용 현황
  const byVisitor = new Map();
  queries.forEach(e => {
    const visitorId = String(e.visitorId || '').trim();
    if (!visitorId) return;
    const dt = toKstDateTimeParts(e.time);
    const t = new Date(e.time).getTime();
    if (!Number.isFinite(t)) return;
    if (!byVisitor.has(visitorId)) byVisitor.set(visitorId, { total: 0, matched: 0, firstT: t, lastT: t, dates: new Set(), topics: new Map() });
    const v = byVisitor.get(visitorId);
    v.total += 1;
    if (e.matched) v.matched += 1;
    if (t < v.firstT) v.firstT = t;
    if (t > v.lastT) v.lastT = t;
    v.dates.add(dt.date);
    const topic = String(e.currentBlock || e.matchedTitle || '').trim();
    if (topic) v.topics.set(topic, (v.topics.get(topic) || 0) + 1);
  });
  const visitorRows = Array.from(byVisitor.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([id, v]) => ({
      방문자: maskVisitorId(id), 총질문수: v.total,
      매칭률: v.total ? Math.round((v.matched / v.total) * 100) : 0,
      활동일수: v.dates.size,
      첫이용: toKstDateTimeParts(new Date(v.firstT).toISOString()).dateTime,
      마지막이용: toKstDateTimeParts(new Date(v.lastT).toISOString()).dateTime,
      자주물어본항목: Array.from(v.topics.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => n + '(' + c + ')').join(', ')
    }));

  // 4) 세션별 이동 경로 (한 세션당 여러 행: 이동 순서대로)
  const byVisitorEntries = new Map();
  queries.forEach((e, idx) => {
    const visitorId = String(e.visitorId || '').trim();
    if (!visitorId) return;
    const t = new Date(e.time).getTime();
    if (!Number.isFinite(t)) return;
    if (!byVisitorEntries.has(visitorId)) byVisitorEntries.set(visitorId, []);
    byVisitorEntries.get(visitorId).push({ t, dateTime: toKstDateTimeParts(e.time).dateTime, block: e.currentBlock || e.matchedTitle || '', query: e.query || e.buttonText || '' });
  });
  const sessionRows = [];
  byVisitorEntries.forEach((entries, visitorId) => {
    entries.sort((a, b) => a.t - b.t);
    let session = [];
    let sessionNo = 0;
    const flush = () => {
      if (session.length >= 2) {
        sessionNo += 1;
        session.forEach((s, i) => {
          sessionRows.push({ 방문자: maskVisitorId(visitorId), 세션번호: sessionNo, 순서: i + 1, 시간: s.dateTime, 블록: s.block || s.query || '(블록 미상)' });
        });
      }
      session = [];
    };
    entries.forEach(e => {
      if (session.length && (e.t - session[session.length - 1].t) > SESSION_GAP_MS) flush();
      session.push(e);
    });
    flush();
  });

  // 5) 일별 통계
  const dailyRows = buildDailyStats(queries, 0).map(d => ({
    일자: d.date, 질문수: d.total, 순방문자: d.uniqueVisitors,
    직접입력: d.directInputCount, 버튼클릭: d.buttonClickCount,
    매칭: d.matchedCount, 미매칭: d.unmatchedCount, 매칭률: d.matchRate + '%'
  }));

  // 6) 학습된 표현
  const learnedAll = readJson(LEARNED_PATH, []);
  const learnedRows = learnedAll.map(e => ({ 등록한문장: e.text || '', 연결된항목: e.blockTitle || '' }));

  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 안내: '해당 기간에 데이터가 없습니다.' }]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  addSheet('질문내역', questionRows);
  addSheet('놓친질문', missedRows);
  addSheet('방문자별', visitorRows);
  addSheet('세션경로', sessionRows);
  addSheet('일별통계', dailyRows);
  addSheet('학습된표현', learnedRows);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = '챗봇데이터_' + (period.from || '전체') + '_' + (period.to || '전체') + '.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
  res.send(buf);
});

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  const q = String(req.query.q || '').trim().toLowerCase();
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 200, 20), 500);
  const page = Math.max(Number(req.query.page) || 1, 1);

  let rows = list.map((e, idx) => {
    const dt = toKstDateTimeParts(e.time);
    return {
      idx,
      date: dt.date,
      time: dt.time,
      dateTime: dt.dateTime,
      query: e.query || '',
      matched: !!e.matched,
      result: e.matched ? '매칭' : '미매칭',
      matchedTitle: e.matchedTitle || '',
      source: e.source || '',
      inputType: e.inputType || '기록없음',
      triggerType: e.triggerType || '',
      buttonText: e.buttonText || '',
      referrerBlock: e.referrerBlock || '',
      referrerBlockId: e.referrerBlockId || '',
      currentBlock: e.currentBlock || '',
      currentBlockId: e.currentBlockId || '',
      lastBlock: e.lastBlock || '',
      lastBlockId: e.lastBlockId || ''
    };
  });

  const period = getAdminPeriod(req.query);
  if (period.from) rows = rows.filter(r => r.date >= period.from);
  if (period.to) rows = rows.filter(r => r.date <= period.to);
  if (q) rows = rows.filter(r => (`${r.query} ${r.matchedTitle} ${r.referrerBlock} ${r.currentBlock} ${r.lastBlock}`).toLowerCase().includes(q));
  rows.sort((a, b) => b.idx - a.idx);

  const total = rows.length;
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  res.json({ total, page: safePage, pageSize, pages, period, items: rows.slice(start, start + pageSize) });
});

app.get('/api/admin/questions.csv', requireAdmin, (req, res) => {
  const list = readJson(QUERIES_PATH, []);
  let rows = list.map((e, idx) => {
    const dt = toKstDateTimeParts(e.time);
    return {
      idx,
      date: dt.date,
      time: dt.time,
      query: e.query || '',
      result: e.matched ? '매칭' : '미매칭',
      matchedTitle: e.matchedTitle || '',
      source: e.source || '',
      inputType: e.inputType || '기록없음',
      triggerType: e.triggerType || '',
      buttonText: e.buttonText || '',
      referrerBlock: e.referrerBlock || '',
      referrerBlockId: e.referrerBlockId || '',
      currentBlock: e.currentBlock || '',
      currentBlockId: e.currentBlockId || '',
      lastBlock: e.lastBlock || '',
      lastBlockId: e.lastBlockId || ''
    };
  });
  const period = getAdminPeriod(req.query);
  if (period.from) rows = rows.filter(r => r.date >= period.from);
  if (period.to) rows = rows.filter(r => r.date <= period.to);
  rows.sort((a, b) => b.idx - a.idx);
  const csv = toCsv(rows, [
    { key: 'date', label: '일자(KST)' },
    { key: 'time', label: '시간(KST)' },
    { key: 'query', label: '질문' },
    { key: 'result', label: '결과' },
    { key: 'matchedTitle', label: '연결 항목' },
    { key: 'inputType', label: '입력유형' },
    { key: 'buttonText', label: '버튼내용' },
    { key: 'referrerBlock', label: '버튼/상호작용 출발블록' },
    { key: 'currentBlock', label: '현재 스킬블록' },
    { key: 'lastBlock', label: '직전블록' },
    { key: 'triggerType', label: '카카오 Trigger Type' },
    { key: 'source', label: '유입경로' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="all-questions.csv"');
  res.send(csv);
});

// 놓친 질문 원본 내역: 빈도 요약과 별도로 날짜별로 하나씩 확인
app.get('/api/admin/missed-detail', requireAdmin, (req, res) => {
  const list = readJson(MISSED_PATH, []);
  const q = String(req.query.q || '').trim().toLowerCase();
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 200, 20), 500);
  const page = Math.max(Number(req.query.page) || 1, 1);

  let rows = list.map((e, idx) => {
    const dt = toKstDateTimeParts(e.time);
    return {
      idx,
      date: dt.date,
      time: dt.time,
      dateTime: dt.dateTime,
      query: e.query || '',
      bestGuessTitle: e.bestGuessTitle || '',
      bestGuessScore: e.bestGuessScore === '' || e.bestGuessScore == null ? '' : e.bestGuessScore
    };
  });
  const period = getAdminPeriod(req.query);
  if (period.from) rows = rows.filter(r => r.date >= period.from);
  if (period.to) rows = rows.filter(r => r.date <= period.to);
  if (q) rows = rows.filter(r => (`${r.query} ${r.bestGuessTitle}`).toLowerCase().includes(q));
  rows.sort((a, b) => b.idx - a.idx);

  const total = rows.length;
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * pageSize;
  res.json({ total, page: safePage, pageSize, pages, period, items: rows.slice(start, start + pageSize) });
});

app.get('/api/admin/missed-detail.csv', requireAdmin, (req, res) => {
  const list = readJson(MISSED_PATH, []);
  let rows = list.map((e, idx) => {
    const dt = toKstDateTimeParts(e.time);
    return {
      idx,
      date: dt.date,
      time: dt.time,
      query: e.query || '',
      bestGuessTitle: e.bestGuessTitle || '',
      bestGuessScore: e.bestGuessScore === '' || e.bestGuessScore == null ? '' : e.bestGuessScore
    };
  });
  const period = getAdminPeriod(req.query);
  if (period.from) rows = rows.filter(r => r.date >= period.from);
  if (period.to) rows = rows.filter(r => r.date <= period.to);
  rows.sort((a, b) => b.idx - a.idx);
  const csv = toCsv(rows, [
    { key: 'date', label: '일자(KST)' },
    { key: 'time', label: '시간(KST)' },
    { key: 'query', label: '놓친 질문' },
    { key: 'bestGuessTitle', label: '추정 항목' },
    { key: 'bestGuessScore', label: '추정 점수' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="missed-questions-daily.csv"');
  res.send(csv);
});

app.get('/api/admin/stats/top.csv', requireAdmin, (req, res) => {
  const list = filterByKstPeriod(readJson(QUERIES_PATH, []), req.query);
  const byTitle = {};
  list.forEach(e => { if (e.matched && e.matchedTitle) byTitle[e.matchedTitle] = (byTitle[e.matchedTitle]||0)+1; });
  const rows = Object.entries(byTitle).sort((a,b)=>b[1]-a[1]).map(([title,count])=>({title,count}));
  const csv = toCsv(rows, [{ key: 'title', label: '항목' }, { key: 'count', label: '건수' }]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="top-questions.csv"');
  res.send(csv);
});

app.get('/api/admin/stats/daily.csv', requireAdmin, (req, res) => {
  const list = filterByKstPeriod(readJson(QUERIES_PATH, []), req.query);
  // 조회기간이 있으면 해당 기간만, 없으면 전체 일별 통계를 내려받습니다.
  const rows = buildDailyStats(list, 0);
  const csv = toCsv(rows, [
    { key: 'date', label: '일자(KST)' },
    { key: 'total', label: '질문수' },
    { key: 'uniqueVisitors', label: '순방문자' },
    { key: 'matchedCount', label: '매칭' },
    { key: 'unmatchedCount', label: '미매칭' },
    { key: 'directInputCount', label: '직접입력' },
    { key: 'buttonClickCount', label: '버튼클릭' },
    { key: 'matchRate', label: '매칭률(%)' }
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daily-stats.csv"');
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
  .card h2{cursor:pointer;user-select:none}
  .hdrRight{display:flex;align-items:center;gap:8px}
  .chev{display:inline-block;font-size:11px;color:#999;transition:transform .15s ease}
  .card.collapsed .chev{transform:rotate(-90deg)}
  .card.collapsed .cardBody{display:none}
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
    <datalist id="blockTitleList"></datalist>
    <h1>경상남도교육청 민원 챗봇 관리자 대시보드 <button class="ghost" id="logoutBtn" style="height:32px;padding:0 10px;font-size:12px">로그아웃</button></h1>

    <div class="card">
      <h2>기간별 통계 <span class="hdrRight"><a class="dl" id="exportAllXlsx" href="#">전체 자료 엑셀 다운로드</a><button class="ghost" id="refreshBtn" style="height:32px;padding:0 10px;font-size:12px">새로고침</button><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">한국시간(KST) 기준입니다. 날짜를 직접 지정하거나 주간·월간·연간 버튼으로 빠르게 조회할 수 있어요.</div>
      <div class="row gap" style="align-items:center">
        <input id="statsFrom" type="date" style="height:38px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px">
        <span class="small muted">~</span>
        <input id="statsTo" type="date" style="height:38px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px">
        <button id="statsFilterBtn" class="ghost" style="height:38px">기간 조회</button>
        <button class="ghost periodPreset" data-preset="week" style="height:38px">주간</button>
        <button class="ghost periodPreset" data-preset="month" style="height:38px">월간</button>
        <button class="ghost periodPreset" data-preset="year" style="height:38px">연간</button>
        <button class="ghost periodPreset" data-preset="all" style="height:38px">전체</button>
      </div>
      <div class="row gap" style="align-items:center">
        <button id="deletePeriodRecordsBtn" class="danger" style="height:36px">조회기간 테스트 기록 삭제</button>
        <span class="small muted">질문 통계와 놓친 질문 기록을 함께 삭제합니다. 기간을 지정해야 삭제할 수 있어요.</span>
      </div>
      <div class="summary4 gap" id="summary4"></div>
      <div class="gap small muted" id="statsMeta"></div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>조회기간 일별 통계 <span class="hdrRight"><a class="dl" id="dailyCsv" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">선택한 기간 안에서 질문이 있었던 날짜만 표시합니다.</div>
      <div style="overflow-x:auto" class="gap">
        <table id="dailyTable">
          <thead><tr><th>일자</th><th>질문수</th><th>순방문자</th><th>직접입력</th><th>버튼클릭</th><th>매칭</th><th>미매칭</th><th>매칭률</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>입력 방식 · 버튼 이용 <span class="hdrRight"><a class="dl" id="buttonsXlsx" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="summary4" id="inputSummary"></div>
      <div class="small muted gap">카카오 스킬 요청의 Trigger Type을 기준으로 직접입력과 버튼클릭을 구분합니다. 기존 기록 중 Trigger Type이 없던 데이터는 '기록없음'으로 표시됩니다.</div>
      <div style="overflow-x:auto" class="gap">
        <table id="buttonTable">
          <thead><tr><th>버튼에서 전달된 문구</th><th>클릭 횟수</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>Render에서 확인된 카카오 블록 흐름 <span class="hdrRight"><a class="dl" id="blockFlowXlsx" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">스킬 요청에 포함된 현재블록·버튼 출발블록·직전블록을 모두 모아 보여줍니다. 카카오 내부에서만 실행되고 Render 스킬을 호출하지 않은 블록은 여기에는 잡히지 않으며, 그런 블록까지 포함한 전체 호출은 카카오 챗봇 관리자센터의 분석 → 통계에서 확인할 수 있습니다.</div>
      <div style="overflow-x:auto" class="gap">
        <table id="blockFlowTable">
          <thead><tr><th>블록명</th><th>현재 스킬블록</th><th>버튼 출발블록</th><th>직전블록</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>사용자 세션별 이동 경로 <span class="hdrRight"><a class="dl" id="sessionPathsXlsx" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">같은 방문자가 30분 이내에 이어서 누른 블록들을 하나의 세션으로 묶어 이동 경로를 보여줍니다. 스킬이 연결된 블록끼리만 경로에 나타나며, 최소 2단계 이상 이동한 세션만 표시합니다.</div>
      <div style="overflow-x:auto" class="gap">
        <table id="sessionPathTable">
          <thead><tr><th>방문자</th><th>세션 시작</th><th>세션 종료</th><th>이동 경로</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>방문자별 이용 현황 <span class="hdrRight"><a class="dl" id="visitorsXlsx" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">방문자ID(카카오 사용자ID 등)별로 총 질문수·매칭률·자주 물어본 항목을 모아 보여줍니다. 접속 경로가 다르면(예: 카카오톡과 웹챗봇을 각각 이용) 같은 사람이어도 별도 방문자로 잡힐 수 있어요.</div>
      <div class="row gap">
        <input id="visitorSearch" type="text" placeholder="방문자ID 또는 자주 물어본 항목 검색" style="flex:1;min-width:180px;height:38px">
        <button id="visitorFilterBtn" class="ghost" style="height:38px">조회</button>
      </div>
      <div class="small muted gap" id="visitorMeta"></div>
      <div style="overflow-x:auto" class="gap">
        <table id="visitorTable">
          <thead><tr><th>방문자</th><th>총 질문수</th><th>매칭률</th><th>활동일수</th><th>첫 이용</th><th>마지막 이용</th><th>자주 물어본 항목</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>전체 질문 내역 <span class="hdrRight"><a class="dl" id="questionsCsv" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">시작일~종료일을 지정해 기간별로 조회할 수 있고, 테스트 질문은 건별 또는 조회기간 전체를 삭제할 수 있어요.</div>
      <div class="row gap">
        <input id="questionFrom" type="date" style="height:38px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px">
        <span class="small muted" style="align-self:center">~</span>
        <input id="questionTo" type="date" style="height:38px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px">
        <input id="questionSearch" type="text" placeholder="질문 또는 연결 항목 검색" style="flex:1;min-width:180px;height:38px">
        <button id="questionFilterBtn" class="ghost" style="height:38px">조회</button>
        <button id="questionResetBtn" class="ghost" style="height:38px">전체</button>
        <button id="questionDeletePeriodBtn" class="danger" style="height:38px">조회기간 질문 삭제</button>
      </div>
      <div class="small muted gap" id="questionMeta"></div>
      <div style="overflow-x:auto" class="gap">
        <table id="questionsTable">
          <thead><tr><th>일자</th><th>시간</th><th>입력유형</th><th>질문/버튼</th><th>결과</th><th>연결 항목</th><th>버튼 출발블록</th><th>현재 스킬블록</th><th>직전블록</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="row gap" style="justify-content:flex-end">
        <button id="questionPrev" class="ghost" style="height:34px">이전</button>
        <button id="questionNext" class="ghost" style="height:34px">다음</button>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>놓친 질문 요약 (빈도순) <span class="hdrRight"><a class="dl" id="missedCsv" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">같은 뜻으로 보이는 질문은 하나로 묶어서 보여줘요. 자주 놓친 질문부터 학습시키는 걸 추천해요.</div>
      <table id="missedTable"><thead><tr><th>질문</th><th>횟수</th><th>추정 항목</th><th>학습 등록</th></tr></thead><tbody></tbody></table>
      </div>
    </div>

    <div class="card collapsed">
      <h2>놓친 질문 일별 내역 <span class="hdrRight"><a class="dl" id="missedDetailCsv" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <div class="small muted">놓친 질문을 실제 발생한 날짜·시간별로 확인하며 기간별 조회와 삭제가 가능합니다.</div>
      <div class="row gap">
        <input id="missedFrom" type="date" style="height:38px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px">
        <span class="small muted" style="align-self:center">~</span>
        <input id="missedTo" type="date" style="height:38px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px">
        <input id="missedSearch" type="text" placeholder="놓친 질문 검색" style="flex:1;min-width:180px;height:38px">
        <button id="missedFilterBtn" class="ghost" style="height:38px">조회</button>
        <button id="missedResetBtn" class="ghost" style="height:38px">전체</button>
        <button id="missedDeletePeriodBtn" class="danger" style="height:38px">조회기간 놓친질문 삭제</button>
      </div>
      <div class="small muted gap" id="missedDetailMeta"></div>
      <div style="overflow-x:auto" class="gap">
        <table id="missedDetailTable">
          <thead><tr><th>일자</th><th>시간</th><th>놓친 질문</th><th>추정 항목</th><th>점수</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="row gap" style="justify-content:flex-end">
        <button id="missedPrev" class="ghost" style="height:34px">이전</button>
        <button id="missedNext" class="ghost" style="height:34px">다음</button>
      </div>
      </div>
    </div>

    <div class="card collapsed">
      <h2>학습된 표현 <span class="hdrRight"><a class="dl" id="learnedXlsx" href="#">엑셀 다운로드</a><span class="chev">▾</span></span></h2>
      <div class="cardBody">
      <table id="learnedTable"><thead><tr><th>등록한 문장</th><th>연결된 항목</th><th></th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </div>
</div>
<script>
function esc(v){return String(v??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
let TOKEN = sessionStorage.getItem('adminToken') || '';
let BLOCKS = [];
let QUESTION_PAGE = 1;
let MISSED_PAGE = 1;

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

document.querySelectorAll('.card > h2').forEach(h => {
  h.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select, textarea')) return;
    h.closest('.card').classList.toggle('collapsed');
  });
});

function kstTodayString(){
  const d = new Date(Date.now() + 9*60*60*1000);
  return d.toISOString().slice(0,10);
}
function dateAddDays(dateStr, days){
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function firstOfMonth(dateStr){ return dateStr.slice(0,7) + '-01'; }
function firstOfYear(dateStr){ return dateStr.slice(0,4) + '-01-01'; }
function getStatsPeriodParams(){
  const params = new URLSearchParams();
  const from = document.getElementById('statsFrom').value || '';
  const to = document.getElementById('statsTo').value || '';
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}
function syncSectionPeriodsFromStats(){
  const from = document.getElementById('statsFrom').value || '';
  const to = document.getElementById('statsTo').value || '';
  document.getElementById('questionFrom').value = from;
  document.getElementById('questionTo').value = to;
  document.getElementById('missedFrom').value = from;
  document.getElementById('missedTo').value = to;
}

async function loadAll(){
  BLOCKS = await api('/api/admin/blocks');
  const sortedTitles = BLOCKS.map(b=>b.title).sort((a,b)=>String(a).localeCompare(String(b), 'ko'));
  document.getElementById('blockTitleList').innerHTML = sortedTitles.map(t=>'<option value="'+esc(t)+'"></option>').join('');
  await Promise.all([loadStats(), loadQuestions(), loadMissed(), loadMissedDetail(), loadLearned(), loadSessionPaths(), loadVisitors()]);
}

async function loadVisitors(){
  const from = document.getElementById('questionFrom').value || '';
  const to = document.getElementById('questionTo').value || '';
  const q = document.getElementById('visitorSearch').value.trim();
  const params = new URLSearchParams({ limit: '300' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q) params.set('q', q);
  const d = await api('/api/admin/visitors?' + params.toString());
  document.getElementById('visitorMeta').textContent = '전체 ' + d.total + '명 (상위 ' + (d.visitors||[]).length + '명 표시, 질문수 많은 순)';
  document.querySelector('#visitorTable tbody').innerHTML = (d.visitors||[]).map(v=>
    '<tr>'+
      '<td>'+esc(v.visitorId)+'</td>'+
      '<td>'+esc(v.total)+'</td>'+
      '<td>'+esc(v.matchRate)+'%</td>'+
      '<td>'+esc(v.activeDays)+'</td>'+
      '<td class="small muted">'+esc(v.first)+'</td>'+
      '<td class="small muted">'+esc(v.last)+'</td>'+
      '<td class="small muted">'+esc(v.topTopics||'-')+'</td>'+
    '</tr>'
  ).join('') || '<tr><td colspan="7" class="muted">해당 조건의 방문자가 없어요.</td></tr>';
  const visitorsXlsxParams = new URLSearchParams({ token: TOKEN });
  if (from) visitorsXlsxParams.set('from', from);
  if (to) visitorsXlsxParams.set('to', to);
  visitorsXlsxParams.set('type', 'visitors');
  document.getElementById('visitorsXlsx').href = '/api/admin/export-section.xlsx?' + visitorsXlsxParams.toString();
}

async function loadSessionPaths(){
  const from = document.getElementById('questionFrom').value || '';
  const to = document.getElementById('questionTo').value || '';
  const params = new URLSearchParams({ limit: '200', minHops: '2' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const d = await api('/api/admin/session-paths?' + params.toString());
  document.querySelector('#sessionPathTable tbody').innerHTML = (d.sessions||[]).map(s=>
    '<tr>'+
      '<td>'+esc(s.visitorId)+'</td>'+
      '<td>'+esc(s.start)+'</td>'+
      '<td>'+esc(s.end)+'</td>'+
      '<td>'+s.path.map(p => esc(p.block || p.query || '(블록 미상)')).join(' <span class="muted">→</span> ')+'</td>'+
    '</tr>'
  ).join('') || '<tr><td colspan="4" class="muted">2단계 이상 이어진 세션이 아직 없어요. 여러 블록에 스킬이 연결될수록 더 많이 잡혀요.</td></tr>';
  const sessionPathsXlsxParams = new URLSearchParams({ token: TOKEN });
  if (from) sessionPathsXlsxParams.set('from', from);
  if (to) sessionPathsXlsxParams.set('to', to);
  sessionPathsXlsxParams.set('type', 'sessionPaths');
  document.getElementById('sessionPathsXlsx').href = '/api/admin/export-section.xlsx?' + sessionPathsXlsxParams.toString();
}

async function loadStats(){
  const params = getStatsPeriodParams();
  const s = await api('/api/admin/stats' + (params.toString() ? '?' + params.toString() : ''));
  document.getElementById('summary4').innerHTML = [
    ['전체 질문', s.total],
    ['매칭률', s.matchRate + '%'],
    ['순방문자', s.uniqueVisitors],
    ['1인당 평균 질문', s.avgQueriesPerVisitor]
  ].map(([l,n])=>'<div class="stat"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>').join('');
  const directCount = (s.byInputType||{})['직접입력'] || 0;
  const buttonCount = (s.byInputType||{})['버튼클릭'] || 0;
  const unknownInputCount = (s.byInputType||{})['기록없음'] || 0;
  document.getElementById('statsMeta').textContent = '조회기간: ' + ((s.period||{}).label || '전체 기간') + ' / 매칭 ' + s.matchedCount + '건 / 미매칭 ' + s.unmatchedCount + '건 / 직접입력 ' + directCount + '건 / 버튼 ' + buttonCount + '건 / 저장: ' + (s.storage === 'supabase' ? 'Supabase 영구보존' : 'Render 로컬');
  const dailyCsvParams = getStatsPeriodParams();
  dailyCsvParams.set('token', TOKEN);
  dailyCsvParams.set('type', 'daily');
  document.getElementById('dailyCsv').href = '/api/admin/export-section.xlsx?' + dailyCsvParams.toString();
  const exportAllParams = getStatsPeriodParams();
  exportAllParams.set('token', TOKEN);
  document.getElementById('exportAllXlsx').href = '/api/admin/export-all.xlsx?' + exportAllParams.toString();
  const missedCsvParams = getStatsPeriodParams();
  missedCsvParams.set('token', TOKEN);
  missedCsvParams.set('type', 'missedSummary');
  document.getElementById('missedCsv').href = '/api/admin/export-section.xlsx?' + missedCsvParams.toString();
  document.getElementById('inputSummary').innerHTML = [
    ['직접입력', directCount],
    ['버튼클릭', buttonCount],
    ['기록없음', unknownInputCount],
    ['버튼 종류', (s.topButtons||[]).length]
  ].map(([l,n])=>'<div class="stat"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>').join('');
  document.querySelector('#buttonTable tbody').innerHTML = (s.topButtons||[]).map(b=>
    '<tr><td>'+esc(b.label)+'</td><td>'+esc(b.count)+'</td></tr>'
  ).join('') || '<tr><td colspan="2" class="muted">아직 기록된 버튼 클릭이 없어요.</td></tr>';
  const buttonsXlsxParams = getStatsPeriodParams(); buttonsXlsxParams.set('token', TOKEN); buttonsXlsxParams.set('type', 'buttons');
  document.getElementById('buttonsXlsx').href = '/api/admin/export-section.xlsx?' + buttonsXlsxParams.toString();
  document.querySelector('#blockFlowTable tbody').innerHTML = (s.blockFlows||[]).map(b=>
    '<tr><td>'+esc(b.name)+'</td><td>'+esc(b.current||0)+'</td><td>'+esc(b.referrer||0)+'</td><td>'+esc(b.last||0)+'</td></tr>'
  ).join('') || '<tr><td colspan="4" class="muted">아직 Render가 확인한 블록 정보가 없어요.</td></tr>';
  const blockFlowXlsxParams = getStatsPeriodParams(); blockFlowXlsxParams.set('token', TOKEN); blockFlowXlsxParams.set('type', 'blockFlow');
  document.getElementById('blockFlowXlsx').href = '/api/admin/export-section.xlsx?' + blockFlowXlsxParams.toString();
  document.querySelector('#dailyTable tbody').innerHTML = (s.days||[]).map(d=>
    '<tr>'+
      '<td>'+esc(d.date)+'</td>'+
      '<td>'+esc(d.total)+'</td>'+
      '<td>'+esc(d.uniqueVisitors)+'</td>'+
      '<td>'+esc(d.directInputCount||0)+'</td>'+
      '<td>'+esc(d.buttonClickCount||0)+'</td>'+
      '<td>'+esc(d.matchedCount)+'</td>'+
      '<td>'+esc(d.unmatchedCount)+'</td>'+
      '<td>'+esc(d.matchRate)+'%</td>'+
    '</tr>'
  ).join('') || '<tr><td colspan="8" class="muted">아직 일별 통계가 없어요.</td></tr>';
}

async function loadQuestions(page){
  if (page != null) QUESTION_PAGE = Math.max(Number(page)||1, 1);
  const from = document.getElementById('questionFrom').value || '';
  const to = document.getElementById('questionTo').value || '';
  const q = document.getElementById('questionSearch').value.trim();
  const params = new URLSearchParams({ page:String(QUESTION_PAGE), pageSize:'200' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q) params.set('q', q);
  const d = await api('/api/admin/questions?' + params.toString());
  QUESTION_PAGE = d.page || 1;
  document.getElementById('questionMeta').textContent = '전체 ' + d.total + '건 · ' + QUESTION_PAGE + '/' + d.pages + '페이지 (페이지당 최대 200건)';
  document.querySelector('#questionsTable tbody').innerHTML = (d.items||[]).map(e=>
    '<tr>'+ 
      '<td>'+esc(e.date)+'</td>'+ 
      '<td>'+esc(e.time)+'</td>'+ 
      '<td>'+(e.inputType === '버튼클릭' ? '<span class="badge">버튼클릭</span>' : (e.inputType === '직접입력' ? '<span class="badge ok">직접입력</span>' : '<span class="small muted">'+esc(e.inputType||'기록없음')+'</span>'))+'</td>'+
      '<td>'+esc(e.buttonText || e.query)+'</td>'+ 
      '<td>'+(e.matched ? '<span class="badge ok">매칭</span>' : '<span class="badge" style="background:#fde8e8;color:#b02a2a">미매칭</span>')+'</td>'+ 
      '<td class="small muted">'+esc(e.matchedTitle||'-')+'</td>'+ 
      '<td class="small muted">'+esc(e.referrerBlock||'-')+'</td>'+
      '<td class="small muted">'+esc(e.currentBlock||'-')+'</td>'+
      '<td class="small muted">'+esc(e.lastBlock||'-')+'</td>'+
      '<td><button class="danger delQuestion" style="height:30px;padding:0 9px;font-size:11px" data-i="'+esc(e.idx)+'">삭제</button></td>'+
    '</tr>'
  ).join('') || '<tr><td colspan="10" class="muted">해당 조건의 질문이 없어요.</td></tr>';
  document.getElementById('questionPrev').disabled = QUESTION_PAGE <= 1;
  document.getElementById('questionNext').disabled = QUESTION_PAGE >= (d.pages||1);
  const csvParams = new URLSearchParams({ token:TOKEN, type:'questionsAll' });
  if (from) csvParams.set('from', from);
  if (to) csvParams.set('to', to);
  document.getElementById('questionsCsv').href = '/api/admin/export-section.xlsx?' + csvParams.toString();

  document.querySelectorAll('.delQuestion').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if (!confirm('이 질문 기록 1건을 삭제할까요?\\n삭제하면 통계와 Supabase 저장 데이터에서도 빠집니다.')) return;
      btn.disabled = true;
      try {
        await api('/api/admin/questions/' + btn.dataset.i, { method:'DELETE' });
        await Promise.all([loadStats(), loadQuestions(QUESTION_PAGE)]);
      } finally { btn.disabled = false; }
    });
  });
}

async function loadMissedDetail(page){
  if (page != null) MISSED_PAGE = Math.max(Number(page)||1, 1);
  const from = document.getElementById('missedFrom').value || '';
  const to = document.getElementById('missedTo').value || '';
  const q = document.getElementById('missedSearch').value.trim();
  const params = new URLSearchParams({ page:String(MISSED_PAGE), pageSize:'200' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (q) params.set('q', q);
  const d = await api('/api/admin/missed-detail?' + params.toString());
  MISSED_PAGE = d.page || 1;
  document.getElementById('missedDetailMeta').textContent = '전체 ' + d.total + '건 · ' + MISSED_PAGE + '/' + d.pages + '페이지 (페이지당 최대 200건)';
  document.querySelector('#missedDetailTable tbody').innerHTML = (d.items||[]).map(e=>
    '<tr>'+ 
      '<td>'+esc(e.date)+'</td>'+ 
      '<td>'+esc(e.time)+'</td>'+ 
      '<td>'+esc(e.query)+'</td>'+ 
      '<td class="small muted">'+esc(e.bestGuessTitle||'-')+'</td>'+ 
      '<td class="small muted">'+esc(e.bestGuessScore===''?'-':e.bestGuessScore)+'</td>'+ 
      '<td><button class="danger delMissedDetail" style="height:30px;padding:0 9px;font-size:11px" data-i="'+esc(e.idx)+'">삭제</button></td>'+
    '</tr>'
  ).join('') || '<tr><td colspan="6" class="muted">해당 조건의 놓친 질문이 없어요.</td></tr>';
  document.getElementById('missedPrev').disabled = MISSED_PAGE <= 1;
  document.getElementById('missedNext').disabled = MISSED_PAGE >= (d.pages||1);
  const csvParams = new URLSearchParams({ token:TOKEN, type:'missedDetail' });
  if (from) csvParams.set('from', from);
  if (to) csvParams.set('to', to);
  document.getElementById('missedDetailCsv').href = '/api/admin/export-section.xlsx?' + csvParams.toString();

  document.querySelectorAll('.delMissedDetail').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      if (!confirm('이 놓친 질문 기록 1건을 삭제할까요?')) return;
      btn.disabled = true;
      try {
        await api('/api/admin/missed-detail/' + btn.dataset.i, { method:'DELETE' });
        await Promise.all([loadMissed(), loadMissedDetail(MISSED_PAGE)]);
      } finally { btn.disabled = false; }
    });
  });
}

async function loadMissed(){
  const params = getStatsPeriodParams();
  params.set('limit', '100');
  const d = await api('/api/admin/missed-summary?' + params.toString());
  document.querySelector('#missedTable tbody').innerHTML = (d.items||[]).map(g=>{
    const learnedBadge = g.alreadyLearned ? ' <span class="badge ok">학습됨</span>' : '';
    return '<tr>'+
      '<td>'+esc(g.sample)+learnedBadge+'</td>'+
      '<td>'+esc(g.count)+'</td>'+
      '<td class="small muted">'+esc(g.bestGuessTitle||'-')+'</td>'+
      '<td><div class="row">'+
        '<input type="text" list="blockTitleList" placeholder="항목 검색(ㄱㄴㄷ)" data-key="'+esc(g.key)+'" data-text="'+esc(g.sample)+'" class="teachInput" style="height:36px;border:1px solid #cfd6dd;border-radius:9px;padding:0 9px;width:180px">'+
        '<button class="ghost teachBtn" style="height:36px;padding:0 10px;font-size:12px" data-key="'+esc(g.key)+'" data-text="'+esc(g.sample)+'">학습</button>'+
      '</div></td>'+
    '</tr>';
  }).join('') || '<tr><td colspan="4" class="muted">놓친 질문이 없어요.</td></tr>';

  document.querySelectorAll('.teachBtn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const input = document.querySelector('.teachInput[data-key="'+btn.dataset.key+'"]');
      const titleTyped = input.value.trim();
      const block = BLOCKS.find(b => b.title === titleTyped);
      if (!block) { alert('목록에 있는 항목명을 정확히 선택해주세요.'); input.focus(); return; }
      btn.disabled = true;
      try{
        await api('/api/learn', { method:'POST', body: JSON.stringify({ text: btn.dataset.text, blockIdx: block.idx }) });
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

  const learnedXlsxParams = new URLSearchParams({ token: TOKEN, type: 'learned' });
  document.getElementById('learnedXlsx').href = '/api/admin/export-section.xlsx?' + learnedXlsxParams.toString();

  document.querySelectorAll('.delLearn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      btn.disabled = true;
      try { await api('/api/learn/'+btn.dataset.i, { method:'DELETE' }); await loadLearned(); }
      finally { btn.disabled = false; }
    });
  });
}

async function applyStatsPeriod(){
  syncSectionPeriodsFromStats();
  QUESTION_PAGE = 1;
  MISSED_PAGE = 1;
  await Promise.all([loadStats(), loadQuestions(), loadMissed(), loadMissedDetail()]);
}
document.getElementById('statsFilterBtn').addEventListener('click', applyStatsPeriod);
document.querySelectorAll('.periodPreset').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const today = kstTodayString();
    const preset = btn.dataset.preset;
    let from = '', to = '';
    if (preset === 'week') { from = dateAddDays(today, -6); to = today; }
    else if (preset === 'month') { from = firstOfMonth(today); to = today; }
    else if (preset === 'year') { from = firstOfYear(today); to = today; }
    document.getElementById('statsFrom').value = from;
    document.getElementById('statsTo').value = to;
    await applyStatsPeriod();
  });
});
document.getElementById('deletePeriodRecordsBtn').addEventListener('click', async ()=>{
  const from = document.getElementById('statsFrom').value || '';
  const to = document.getElementById('statsTo').value || '';
  if (!from && !to) { alert('삭제할 기간을 먼저 지정해 주세요. 전체 기록은 이 버튼으로 삭제되지 않습니다.'); return; }
  const label = (from || '처음') + ' ~ ' + (to || '현재');
  if (!confirm(label + ' 기간의 질문 통계와 놓친 질문 기록을 모두 삭제할까요?\\n테스트 기록 정리용이며 삭제 후 되돌릴 수 없습니다.')) return;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const d = await api('/api/admin/records?' + params.toString(), { method:'DELETE' });
  alert('질문 ' + (d.removedQueries||0) + '건, 놓친 질문 ' + (d.removedMissed||0) + '건을 삭제했습니다.');
  QUESTION_PAGE = 1; MISSED_PAGE = 1;
  await loadAll();
});

document.getElementById('questionFilterBtn').addEventListener('click', ()=>{ QUESTION_PAGE=1; loadQuestions(); loadSessionPaths(); loadVisitors(); });
document.getElementById('visitorFilterBtn').addEventListener('click', ()=>{ loadVisitors(); });
document.getElementById('questionResetBtn').addEventListener('click', ()=>{ document.getElementById('questionFrom').value=''; document.getElementById('questionTo').value=''; document.getElementById('questionSearch').value=''; QUESTION_PAGE=1; loadQuestions(); loadSessionPaths(); loadVisitors(); });
document.getElementById('questionDeletePeriodBtn').addEventListener('click', async ()=>{
  const from = document.getElementById('questionFrom').value || '';
  const to = document.getElementById('questionTo').value || '';
  if (!from && !to) { alert('삭제할 기간을 먼저 지정해 주세요.'); return; }
  if (!confirm((from||'처음') + ' ~ ' + (to||'현재') + ' 기간의 질문 기록을 모두 삭제할까요?\\n놓친 질문 원본은 별도로 유지됩니다.')) return;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const d = await api('/api/admin/questions?' + params.toString(), { method:'DELETE' });
  alert((d.removed||0) + '건을 삭제했습니다.');
  QUESTION_PAGE=1;
  await Promise.all([loadStats(), loadQuestions()]);
});
document.getElementById('questionSearch').addEventListener('keydown', e=>{ if(e.key==='Enter'){ QUESTION_PAGE=1; loadQuestions(); } });
document.getElementById('questionPrev').addEventListener('click', ()=>loadQuestions(QUESTION_PAGE-1));
document.getElementById('questionNext').addEventListener('click', ()=>loadQuestions(QUESTION_PAGE+1));

document.getElementById('missedFilterBtn').addEventListener('click', ()=>{ MISSED_PAGE=1; loadMissedDetail(); });
document.getElementById('missedResetBtn').addEventListener('click', ()=>{ document.getElementById('missedFrom').value=''; document.getElementById('missedTo').value=''; document.getElementById('missedSearch').value=''; MISSED_PAGE=1; loadMissedDetail(); });
document.getElementById('missedDeletePeriodBtn').addEventListener('click', async ()=>{
  const from = document.getElementById('missedFrom').value || '';
  const to = document.getElementById('missedTo').value || '';
  if (!from && !to) { alert('삭제할 기간을 먼저 지정해 주세요.'); return; }
  if (!confirm((from||'처음') + ' ~ ' + (to||'현재') + ' 기간의 놓친 질문 기록을 모두 삭제할까요?')) return;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const d = await api('/api/admin/missed-detail?' + params.toString(), { method:'DELETE' });
  alert((d.removed||0) + '건을 삭제했습니다.');
  MISSED_PAGE=1;
  await Promise.all([loadMissed(), loadMissedDetail()]);
});
document.getElementById('missedSearch').addEventListener('keydown', e=>{ if(e.key==='Enter'){ MISSED_PAGE=1; loadMissedDetail(); } });
document.getElementById('missedPrev').addEventListener('click', ()=>loadMissedDetail(MISSED_PAGE-1));
document.getElementById('missedNext').addEventListener('click', ()=>loadMissedDetail(MISSED_PAGE+1));

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('token').addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });
document.getElementById('logoutBtn').addEventListener('click', ()=>logout(''));
document.getElementById('refreshBtn').addEventListener('click', loadAll);

if (TOKEN) { document.getElementById('token').value=''; login(); }
</script>
</body></html>`);
});

// Render/외부 모니터에서 가장 가볍게 확인할 수 있는 상태 확인 URL입니다.
// 업무분장 조회나 AI 호출을 전혀 하지 않아 빠르게 200 응답만 반환합니다.
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, service: 'gne-minwon-chatbot', storage: SUPABASE_ENABLED ? 'supabase' : 'local', ts: Date.now() });
});

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Render가 막 깨어난 직후 공식 업무분장 홈페이지가 잠깐 느려도
// 1회 실패로 끝내지 않고 백그라운드에서 몇 차례 재시도합니다.
async function warmHqContactsWithRetry() {
  const delays = [0, 2500, 7000];
  let lastErr = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await waitMs(delays[i]);
    try {
      const rows = await refreshGneHqContacts(12000);
      console.log(`✅ 본청 업무담당자 시작 캐시 준비 완료: ${Array.isArray(rows) ? rows.length : 0}건 (시도 ${i + 1}/${delays.length})`);
      return rows;
    } catch (err) {
      lastErr = err;
      console.error(`본청 업무담당자 시작 캐시 재시도 ${i + 1}/${delays.length} 실패:`, err && err.message ? err.message : err);
    }
  }
  throw lastErr || new Error('본청 업무담당자 시작 캐시 준비 실패');
}

function startRenderKeepWarm() {
  if (!KEEP_WARM_ENABLED) {
    console.log('ℹ Render keep-warm 비활성화 (KEEP_WARM_ENABLED=true 로 활성화 가능)');
    return;
  }

  const healthUrl = `${PUBLIC_BASE_URL}/healthz`;
  console.log(`✅ Render keep-warm 활성화: 약 ${Math.round(KEEP_WARM_INTERVAL_MS / 60000)}분 간격 → ${healthUrl}`);

  const ping = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'user-agent': 'GNE-1004-Render-KeepWarm/1.0' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      console.error('Render keep-warm 호출 실패:', err && err.message ? err.message : err);
    } finally {
      clearTimeout(timeout);
    }
  };

  // 첫 호출은 12분 뒤에 하므로 서버 시작 직후 불필요한 추가 요청은 만들지 않습니다.
  const timer = setInterval(ping, KEEP_WARM_INTERVAL_MS);
  if (timer.unref) timer.unref();
}


// ---- 교육 제증명 통합 안내 페이지 ----
// 카카오 챗봇의 '증명서 발급(제증명)' 메뉴에서 이 페이지로 연결할 수 있습니다.


app.get('/', (req, res) => {
  res.send('경상남도교육청 민원 챗봇 백엔드가 정상적으로 실행 중입니다.');
});

async function startServer() {
  // 서버가 외부 요청을 받기 전에 Supabase에 저장된 통계/학습 데이터를 먼저 복구합니다.
  await initSupabasePersistence();

  
// ===== 민원 통합안내 추가 페이지: 전·입학 / 검정고시 / 수능 =====
function gneGuidePage({title, subtitle, accent, tabs, body, sourceUrl, sourceLabel}) {
  const tabHtml = tabs.map(t => `<a class="chip" href="#${t.id}">${t.label}</a>`).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} | 경상남도교육청 민원안내</title>
  <style>
  *{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR","Malgun Gothic",sans-serif;line-height:1.65}
  .wrap{max-width:920px;margin:auto;padding:24px 16px 64px}.hero{background:white;border-radius:24px;padding:28px;box-shadow:0 8px 30px rgba(30,45,80,.08);border-top:6px solid ${accent}}
  h1{font-size:28px;margin:0 0 8px}.sub{color:#59657a}
  .official{margin-top:18px;background:linear-gradient(135deg,${accent},#263f78);border-radius:18px;padding:18px;color:white;box-shadow:0 8px 22px rgba(35,55,95,.18)}
  .official strong{font-size:18px;display:block;margin-bottom:4px}.official span{font-size:14px;opacity:.94}
  .official a{display:inline-block;margin-top:12px;background:white;color:#1f2a44!important;text-decoration:none;font-weight:900;padding:11px 15px;border-radius:12px}
  .searchbox{margin-top:16px;background:#f8faff;border:1px solid #dfe6f2;border-radius:16px;padding:14px}
  .searchbox label{display:block;font-weight:900;margin-bottom:8px}
  .searchrow{display:flex;gap:8px}.searchrow input{flex:1;min-width:0;border:1px solid #cfd8e6;border-radius:12px;padding:13px 14px;font-size:16px;outline:none}
  .searchrow input:focus{border-color:${accent};box-shadow:0 0 0 3px rgba(70,90,170,.12)}
  .searchcount{font-size:13px;color:#6b778c;margin-top:7px}
  .content-layout{display:block;margin-top:16px}
  .faq-sidebar{position:fixed;top:110px;right:calc(50% - 650px);width:170px;z-index:20;background:#fff;border-radius:18px;padding:14px;box-shadow:0 8px 28px rgba(30,45,80,.10);border:1px solid #e6eaf1}
  .sidebar-title{font-weight:900;font-size:16px;margin-bottom:8px;padding:6px 8px 10px;border-bottom:1px solid #e8ecf3}
  .faq-sidebar a{display:block;text-decoration:none;color:#344054;font-weight:800;padding:10px 9px;border-radius:10px;margin:2px 0}
  .faq-sidebar a:hover{background:#f1f4f9}
  .faq-main{min-width:0}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.chip{padding:9px 13px;border-radius:999px;background:#eef2f8;color:#24324a;text-decoration:none;font-weight:700;font-size:14px}
  section{background:white;border-radius:20px;padding:22px;margin-top:16px;box-shadow:0 4px 18px rgba(30,45,80,.05)}h2{font-size:21px;margin:0 0 12px}
  details{border-top:1px solid #e8ecf3;padding:13px 0}details:first-of-type{border-top:0}summary{cursor:pointer;font-weight:800}.answer{padding:10px 2px 2px;color:#39465b}
  .notice{background:#f7f9fc;border-radius:14px;padding:13px 15px;margin:12px 0}.buttons{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}
  .btn{display:inline-block;text-decoration:none;background:${accent};color:white!important;font-weight:800;padding:11px 15px;border-radius:12px}.btn.light{background:#eef2f8;color:#26344b!important}
  .small{font-size:13px;color:#68758a}.warn{font-weight:800;color:#9a4d00}.step{padding-left:20px}a{color:#2459b8}
  .hidden-faq{display:none!important}
  .noresult{display:none;background:white;border-radius:18px;padding:22px;margin-top:16px;text-align:center;color:#667085}
  @media(max-width:1240px){.faq-sidebar{position:static;width:auto;display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:14px}.sidebar-title{grid-column:1/-1}.faq-sidebar a{text-align:center;background:#f6f8fb;padding:9px 6px}.faq-main{width:100%}} @media(max-width:720px){.faq-sidebar{grid-template-columns:repeat(2,1fr)}.sidebar-title{grid-column:1/-1}} @media(max-width:520px){h1{font-size:24px}.hero{padding:20px}.official{padding:16px}section{padding:18px}.searchrow{display:block}.searchrow input{width:100%}}
  </style></head><body><main class="wrap"><div class="hero"><h1>${title}</h1><div class="sub">${subtitle}</div>
  <div class="official"><strong>📌 공식 안내 확인</strong><span>세부 자격·일정·제출서류는 해당 연도 공식 안내가 가장 정확합니다.</span><br><a href="${sourceUrl}" target="_blank" rel="noopener">🔎 ${sourceLabel}</a></div>
  <div class="searchbox"><label for="faqSearch">🔍 자주 묻는 질문 검색</label><div class="searchrow"><input id="faqSearch" type="search" placeholder="궁금한 내용을 입력해 보세요. 예: 전학, 대리접수, 시험장소" autocomplete="off"></div><div id="searchCount" class="searchcount">질문 제목과 답변 내용을 바로 검색할 수 있어요.</div></div>
  <div id="faq-list" class="chips">${tabHtml}</div></div>

  <div class="content-layout">
    <aside class="faq-sidebar">
      <div class="sidebar-title">자주 묻는 질문</div>
      <a href="/guides">전체 보기</a>
      <a href="/certificates">제증명</a>
      <a href="/transfer">전·입학</a>
      <a href="/ged">검정고시</a>
      <a href="/csat">수능</a>
    </aside>
    <div class="faq-main">
      ${body}
      <div id="noResult" class="noresult">검색 결과가 없습니다. 다른 단어로 검색해 보세요.</div>
    </div>
  </div>
  </main>
  <script>
  (function(){
    const input=document.getElementById('faqSearch');
    const count=document.getElementById('searchCount');
    const noResult=document.getElementById('noResult');
    const sections=[...document.querySelectorAll('.faq-main > section')];
    const details=[...document.querySelectorAll('details')];
    const normalize=s=>String(s||'').toLowerCase().replace(/\s+/g,'');
    function run(){
      const q=normalize(input.value);
      let shown=0;
      details.forEach(d=>{
        const hit=!q || normalize(d.textContent).includes(q);
        d.classList.toggle('hidden-faq',!hit);
        if(hit){shown++; if(q) d.open=true;}
        else d.open=false;
      });
      sections.forEach(sec=>{
        const ds=[...sec.querySelectorAll('details')];
        if(!ds.length) return;
        const any=ds.some(d=>!d.classList.contains('hidden-faq'));
        sec.style.display=any?'':'none';
      });
      if(!q){
        count.textContent='질문 제목과 답변 내용을 검색할 수 있어요.';
        noResult.style.display='none';
      }else{
        count.textContent='검색 결과 '+shown+'건';
        noResult.style.display=shown?'none':'block';
      }
    }
    input.addEventListener('input',run); input.addEventListener('search',run); input.addEventListener('change',run);
  })();
  </script>
  </body></html>`;
}

app.get('/certificates', (req,res) => {
 const body = `
 <section id="online"><h2>온라인 발급</h2>
 <details open><summary>학교 관련 증명서는 어디서 발급하나요?</summary><div class="answer">졸업증명서, 성적증명서, 재학증명서, 학교생활기록부 등 일부 교육 관련 증명서는 <b>정부24 등 온라인 서비스</b>를 통해 발급할 수 있습니다. 증명서 종류와 전산자료 보유 여부 등에 따라 온라인 발급 가능 여부가 다를 수 있습니다.
 <div class="buttons"><a class="btn" href="https://www.gov.kr" target="_blank" rel="noopener">정부24 바로가기</a></div></div></details>
 <details><summary>온라인 발급이 안 돼요.</summary><div class="answer">증명서 종류, 졸업연도 또는 전산자료 보유 여부 등에 따라 온라인 발급이 제한될 수 있습니다. 온라인 발급이 되지 않는 경우 학교·교육기관 방문 또는 FAX 민원 등 다른 발급방법을 이용할 수 있습니다.</div></details>
 </section>

 <section id="types"><h2>발급 가능한 증명서</h2>
 <details open><summary>어떤 증명서를 발급할 수 있나요?</summary><div class="answer">
 <b>학생</b>: 졸업증명서, 졸업예정증명서, 재학증명서, 성적증명서, 학교생활기록부 등<br>
 <b>검정고시</b>: 합격증명서, 성적증명서, 과목합격증명서 등<br>
 <b>교직원</b>: 경력증명서, 재직증명서, 퇴직 관련 증명서 등
 <div class="notice small">※ 증명서별 발급 가능 방법은 다를 수 있습니다.</div></div></details>
 </section>

 <section id="proxy"><h2>방문·대리 발급</h2>
 <details open><summary>가족이나 대리인이 대신 발급받을 수 있나요?</summary><div class="answer">
 <p>방문 발급은 대상자의 연령과 방문자에 따라 준비서류가 달라집니다.</p>
 <p><b>① 본인(만 14세 이상)</b><br>본인의 신분증</p>
 <p><b>② 만 14세 이상 대상자의 제3자 방문</b><br>위임장 + 제증명 대상자의 신분증(사본 가능) + 방문 대리인의 신분증</p>
 <p><b>③ 만 14세 미만 대상자를 법정대리인이 직접 방문</b><br>법정대리인의 신분증 + 법정대리인임을 확인할 수 있는 서류</p>
 <p><b>④ 만 14세 미만 대상자의 제3자 방문</b><br>법정대리인의 위임장 + 법정대리인의 신분증(사본 가능) + 방문 대리인의 신분증 + 법정대리인임을 확인할 수 있는 서류</p>
 <div class="buttons"><a class="btn" href="https://www.gne.go.kr/www/minwon/complaints/guide/guide_02.jsp" target="_blank" rel="noopener">구비서류·위임장 확인</a></div>
 </div></details>
 <details><summary>방문 발급은 어떻게 하나요?</summary><div class="answer">민원실 접수 → 증명서 작성(민원실·해당부서) → 민원실 교부 순으로 처리됩니다. 본인이 방문하는 경우 신분증을 준비하고, 대리인이 방문하는 경우에는 대리발급 구비서류를 확인해 주세요.</div></details>
 <details><summary>신분증으로 인정되는 것은 무엇인가요?</summary><div class="answer">주민등록증, 운전면허증, 청소년증, 여권, 공무원증 등 행정기관이 발급한 신분증명서를 사용할 수 있습니다.</div></details>
 </section>

 <section id="closed"><h2>폐교학교·기타</h2>
 <details open><summary>폐교한 학교 증명서가 필요해요.</summary><div class="answer">폐교한 학교의 졸업증명서, 성적증명서, 학교생활기록부 등은 해당 학교의 기록을 보관하고 있는 교육기관에서 발급받을 수 있습니다. 보관기관을 확인한 후 해당 기관으로 신청해 주세요.</div></details>
 <details><summary>다른 지역 학교 증명서도 발급할 수 있나요?</summary><div class="answer">증명서 종류에 따라 전국 교육기관 방문, FAX 민원 또는 온라인 발급 등을 이용할 수 있습니다. 발급하려는 증명서의 방법을 먼저 확인해 주세요.</div></details>
 <details><summary>교직원 경력·재직증명서는 어떻게 발급하나요?</summary><div class="answer">교직원 경력증명서·재직증명서 등도 교육 제증명에 포함됩니다. 경력 종류와 근무기관 등에 따라 처리기관이 달라질 수 있습니다.
 <div class="buttons"><a class="btn light" href="/staff-search">담당부서·문의처 찾기</a></div></div></details>
 </section>`;
 res.send(gneGuidePage({
   title:'교육 제증명 발급 안내',
   subtitle:'졸업·성적·생활기록부, 검정고시, 교직원 증명서 등 자주 묻는 내용을 확인하세요.',
   accent:'#5b55d6',
   tabs:[
     {id:'online',label:'온라인 발급'},
     {id:'types',label:'증명서 종류'},
     {id:'proxy',label:'방문·대리 발급'},
     {id:'closed',label:'폐교학교·기타'}
   ],
   body,
   sourceUrl:'https://www.gne.go.kr/www/minwon/complaints/guide/guide_02.jsp',
   sourceLabel:'경남교육청 제증명 발급안내'
 }));
});

app.get('/transfer', (req,res) => {
 const body = `
 <section id="elementary"><h2>초등학교 전학</h2>
 <details open><summary>초등학교 전학은 어떻게 하나요?</summary><div class="answer">거주지를 이전한 뒤 지역 주민센터(읍·면·동)에 전입신고를 하고 <b>초등학교 배정 신청</b>을 합니다. 배정과 통학구역은 주소지를 기준으로 확인합니다.</div></details>
 <details><summary>어느 학교로 배정되는지 알고 싶어요.</summary><div class="answer">초등학교는 통학구역에 따라 배정되므로 주소지의 학구를 확인해야 합니다. 아래 <b>학구도 안내</b>에서 주소지별 통학구역을 확인해 주세요.
<div class="buttons"><a class="btn" href="https://schoolzone.emac.kr/" target="_blank" rel="noopener">🗺️ 학구도 바로가기</a></div></div></details>
 </section>
 <section id="middle"><h2>중학교 전학</h2>
 <details open><summary>중학교 전학은 어디에 신청하나요?</summary><div class="answer"><b>주소지 관할 교육지원청</b>에서 배정합니다. 지역별 전입학 담당부서와 전화번호는 경남교육청 전입학 안내에서 확인할 수 있습니다.
<div class="buttons"><a class="btn" href="https://www.gne.go.kr/www/chamyeo/admission/emschool.jsp" target="_blank" rel="noopener">📞 지역별 담당자 확인</a></div></div></details>
 <details><summary>다른 시·군으로 이사하는 경우도 같나요?</summary><div class="answer">전입할 주소지의 관할 교육지원청에 배정 절차와 필요서류를 확인하는 것이 가장 정확합니다.</div></details>
 </section>
 <section id="high"><h2>고등학교 전학</h2>
 <details open><summary>고등학교 전학의 기본 요건은 무엇인가요?</summary><div class="answer">2026학년도 경남 지침은 원칙적으로 <b>전 가족이 단독세대를 구성하여 타 학군(지역)으로 거주지를 이전한 경우</b>를 전입학 대상으로 안내합니다. 다만 예외사유와 추가서류가 있으므로 개별 상황은 지침을 확인해야 합니다.</div></details>
 <details><summary>평준화지역은 어떻게 신청하나요?</summary><div class="answer"><ol class="step"><li>거주지 이전</li><li>전출교에서 배정원서 작성</li><li>배정원서와 관련서류를 경상남도교육청에 방문 또는 팩스로 접수</li><li>배정 결과 확인</li></ol><div class="notice">공통서류: 배정원서, 주민등록등본(행정정보 공동이용 시 미제출 가능), 개인정보 수집·이용 동의서 등</div></div></details>
 <details><summary>부모 중 한 명이 함께 이전하지 못해요.</summary><div class="answer">부 또는 모가 불가피하게 함께 이전할 수 없는 경우에는 사유별 <b>추가 제출서류</b>가 필요합니다. 임의로 판단하기보다 경남교육청 고등학교 전입학 지침의 해당 사유를 확인해 주세요.</div></details>
 <details><summary>비평준화지역 고등학교로 전학하고 싶어요.</summary><div class="answer">비평준화지역은 희망 학교의 결원 및 전입학 가능 여부 등 학교별 확인이 필요하므로 <b>전학을 희망하는 학교에 먼저 문의</b>하는 것이 정확합니다.</div></details>
 </section>
 <section id="special"><h2>특별한 경우</h2>
 <details><summary>거주지 이전 없이 전학할 수 있나요?</summary><div class="answer">일반적인 전입학은 거주지 이전을 기본으로 하지만, 지침에서 정한 별도 사유가 적용되는 경우가 있습니다. 진로변경 전입학 등은 별도 일정·대상·요건이 있으므로 해당 메뉴와 시행계획을 확인해 주세요.</div></details>
 <div class="notice small">※ 학교급·지역·평준화 여부·가족 이전 상황에 따라 절차가 달라질 수 있습니다.</div></section>`;
 res.send(gneGuidePage({title:'전·입학 안내',subtitle:'초·중·고 학교급별 전학 절차를 한눈에 확인하세요.',accent:'#5b55d6',
 tabs:[{id:'elementary',label:'초등학교'},{id:'middle',label:'중학교'},{id:'high',label:'고등학교'},{id:'special',label:'특별한 경우'}],body,
 sourceUrl:'https://www.gne.go.kr/www/chamyeo/admission/emschool.jsp',sourceLabel:'경남교육청 전입학 안내'}));
});

app.get('/ged', (req,res) => {
 const body = `
 <section id="apply"><h2>원서접수</h2>
 <details open><summary>검정고시는 언제 접수하나요?</summary><div class="answer">검정고시는 회차별 시행계획에서 <b>현장접수와 온라인접수 기간</b>을 공고합니다. 접수기간은 매회 달라질 수 있으므로 최신 공고를 확인해 주세요.</div></details>
 <details><summary>어디에서 접수하나요?</summary><div class="answer">2026년도 제2회 기준 현장접수처는 <b>경상남도교육청, 진주·김해·통영·거제교육지원청</b>이었습니다. 온라인접수도 운영되며, 매회 공고에서 접수처와 방법을 다시 확인해야 합니다.</div></details>
 <details><summary>온라인접수할 때 주의할 점이 있나요?</summary><div class="answer">온라인 접수는 현장접수보다 마감일이 빠를 수 있습니다. 2026년도 제2회 공고는 마지막 단계에서 반드시 <b>[제출]</b> 버튼까지 클릭해야 접수가 완료된다고 안내했습니다.</div></details>
 </section>
 <section id="eligibility"><h2>응시자격·서류</h2>
 <details open><summary>제가 응시할 수 있는지 알고 싶어요.</summary><div class="answer">초졸·중졸·고졸별 응시자격과 제한사항이 다르므로 해당 회차 <b>시행계획 공고의 응시자격</b>을 확인해야 합니다. 개인 학력·재학/제적 시점에 따라 달라질 수 있어 단순히 나이만으로 판단하기 어렵습니다.</div></details>
 <details><summary>대리접수가 가능한가요?</summary><div class="answer">가능한 경우가 있으나 응시자 연령과 대리인 유형에 따라 <b>위임장, 대리인 신분증, 응시자 신분증 사본, 법정대리인 입증서류</b> 등이 필요할 수 있습니다. 반드시 해당 회차 공고의 대리접수 구비서류를 확인해 주세요.</div></details>
 <details><summary>현장접수 때 신분증 사진으로 대신할 수 있나요?</summary><div class="answer">아니요. 2026년도 제2회 공고는 <b>휴대전화 등으로 촬영한 신분증 사진은 인정하지 않는다</b>고 안내합니다. 주민등록번호 뒷자리가 없는 여권은 여권정보증명서를 함께 준비해야 합니다.</div></details>
 </section>
 <section id="exam"><h2>시험·합격발표</h2>
 <details open><summary>시험일과 시험장은 어디서 확인하나요?</summary><div class="answer">시험일, 시험장소 공고일, 합격자 발표일은 회차별 시행계획에 공고됩니다. 시험장소는 별도 공고될 수 있으므로 접수 후 경남교육청 <b>시험정보 → 검정고시</b> 게시판을 다시 확인해 주세요.</div></details>
 </section>
 <section id="certificate"><h2>합격 후 증명서</h2>
 <details open><summary>합격·성적증명서는 어디서 발급하나요?</summary><div class="answer">검정고시 합격증명서, 성적증명서, 과목합격증명서 등은 교육 제증명에 해당합니다. 발급방법과 대리발급 안내는 <a href="/certificates"><b>교육 제증명 통합안내</b></a>에서 확인해 주세요.</div></details>
 </section>`;
 res.send(gneGuidePage({title:'검정고시 안내',subtitle:'원서접수부터 시험·합격증명서까지 자주 묻는 내용을 모았습니다.',accent:'#1e8a65',
 tabs:[{id:'apply',label:'원서접수'},{id:'eligibility',label:'응시자격·서류'},{id:'exam',label:'시험·합격발표'},{id:'certificate',label:'증명서'}],body,
 sourceUrl:'https://www.gne.go.kr/www/na/ntt/selectNttList.do?mi=12627&bbsId=1255',sourceLabel:'경남교육청 검정고시 공고'}));
});

app.get('/csat', (req,res) => {
 const body = `
 <section id="place"><h2>접수대상·접수처</h2>
 <details open><summary>수능 원서는 어디에서 접수하나요?</summary><div class="answer"><b>재학생은 재학 중인 고등학교, 졸업생은 출신 고등학교</b>가 기본 접수처입니다. 졸업생은 출신학교 소재지와 현재 주민등록상 주소지가 다른 시·도 또는 도내 다른 시험장지역인 경우 등 허용되는 범위에서 별도 접수가 가능하므로 해당 연도 안내를 확인해 주세요.</div></details>
 <details><summary>검정고시 합격자는 어디서 접수하나요?</summary><div class="answer">검정고시 합격자 등 학교 접수가 아닌 대상자는 주민등록상 주소지 등을 기준으로 지정된 시험지구 접수처를 이용하게 됩니다. 정확한 접수처는 해당 연도 경남교육청 수능 원서접수 안내에서 확인해 주세요.</div></details>
 </section>
 <section id="online"><h2>온라인 사전입력</h2>
 <details open><summary>온라인으로만 원서접수를 끝낼 수 있나요?</summary><div class="answer"><b>아니요.</b> 2027학년도 경남 안내 기준 온라인 사전입력 후에도 정해진 기한까지 <b>현장 접수처를 방문하여 접수를 완료</b>해야 합니다.</div></details>
 <details><summary>2027학년도 접수기간은 언제인가요?</summary><div class="answer">응시원서 접수·변경은 <b>2026. 8. 24.(월)~9. 4.(금) 09:00~17:00</b>이며 토요일·공휴일은 제외됩니다. 온라인 사전입력은 <b>8. 20.(목)~9. 3.(목) 18:00</b>까지입니다.<div class="notice warn">※ 일정은 학년도마다 달라지므로 이후에는 반드시 최신 공고를 확인하세요.</div></div></details>
 </section>
 <section id="docs"><h2>준비서류·대리접수</h2>
 <details open><summary>대리접수가 가능한가요?</summary><div class="answer">수능 원서접수는 <b>응시자 본인이 직접 접수하는 것이 원칙</b>입니다. 다만 공식 지침에서 정한 대상자에 한해 직계가족·배우자 등에 의한 대리접수가 허용될 수 있으며, 대상과 구비서류가 엄격하게 정해져 있습니다. 해당 학년도 대리접수 안내와 서약서를 반드시 확인해 주세요.</div></details>
 <details><summary>준비서류는 어디서 확인하나요?</summary><div class="answer">재학생·졸업생·검정고시 합격자 등 대상별 준비서류가 다르며, 대리접수는 별도 서류가 추가됩니다. 아래 공식 원서접수 안내의 첨부자료를 확인해 주세요.</div></details>
 </section>
 <section id="fee"><h2>응시수수료</h2>
 <details open><summary>2027학년도 응시수수료는 얼마인가요?</summary><div class="answer">선택 영역 수에 따라 <b>4개 영역 이하 37,000원 / 5개 영역 42,000원 / 6개 영역 47,000원</b>입니다. 납부방법은 접수처와 온라인 사전입력 사용 여부 등에 따라 안내를 확인해 주세요.</div></details>
 </section>
 <section id="result"><h2>시험·성적</h2>
 <details open><summary>수능 일정이나 성적 관련 정보는 어디서 확인하나요?</summary><div class="answer">시험 시행일, 수험표, 시험장, 성적통지 및 성적증명 관련 사항은 해당 학년도 수능 시행계획과 경남교육청 공지를 확인해 주세요. 연도별로 변동되는 내용은 이 페이지보다 공식 공고가 우선합니다.</div></details>
 </section>`;
 res.send(gneGuidePage({title:'대학수학능력시험 안내',subtitle:'원서접수·접수처·대리접수 등 수능 민원을 빠르게 확인하세요.',accent:'#315ca8',
 tabs:[{id:'place',label:'접수처'},{id:'online',label:'온라인 사전입력'},{id:'docs',label:'서류·대리접수'},{id:'fee',label:'수수료'},{id:'result',label:'시험·성적'}],body,
 sourceUrl:'https://www.gne.go.kr/user/bbs/BD_selectBbs.do?q_bbsDocNo=20260727113531225&q_bbsSn=1256',sourceLabel:'2027학년도 수능 원서접수 안내'}));
});

// 통합 민원안내 허브
app.get('/guides', (req,res) => res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>자주 묻는 질문</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR","Malgun Gothic",sans-serif;background:#f5f7fb;margin:0;color:#172033}.w{max-width:850px;margin:auto;padding:35px 16px}h1{margin-bottom:6px}.sub{color:#657086;margin-bottom:24px}.g{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.c{background:white;border-radius:20px;padding:24px;text-decoration:none;color:inherit;box-shadow:0 5px 20px rgba(30,45,80,.07)}.c b{font-size:20px;display:block;margin-bottom:5px}.c span{color:#657086}@media(max-width:600px){.g{grid-template-columns:1fr}}</style></head><body><main class="w"><h1>자주 묻는 질문</h1><div class="sub">궁금한 교육민원을 빠르게 찾아보세요.</div><div class="g">
<a class="c" href="/certificates"><b>📄 증명서 발급(제증명)</b><span>온라인·방문·대리발급·폐교학교</span></a>
<a class="c" href="/transfer"><b>🏫 전·입학</b><span>초·중·고 학교급별 전학 안내</span></a>
<a class="c" href="/ged"><b>✏️ 검정고시</b><span>접수·응시자격·시험·증명서</span></a>
<a class="c" href="/csat"><b>🎓 대학수학능력시험</b><span>원서접수·접수처·대리접수</span></a>
</div></main></body></html>`));


app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (ADMIN_TOKEN === 'change-me') {
    console.log('⚠ ADMIN_TOKEN 환경변수를 설정하지 않으면 기본값(change-me)이 사용됩니다. 꼭 바꿔주세요.');
  }

  // 카카오 요청이 들어온 뒤 홈페이지 전체(수백 건)를 읽기 시작하면 5초 제한에 걸릴 수 있어
  // 서버가 뜨자마자 백그라운드에서 공식 업무분장을 준비하고, 일시 오류 시 자동 재시도합니다.
  setTimeout(() => {
    warmHqContactsWithRetry().catch(err => {
      console.error('본청 업무담당자 시작 캐시 최종 실패:', err && err.message ? err.message : err);
    });
  }, 250);

  // 공식 통합검색의 검색 폼도 미리 읽어 두어 첫 민원인의 응답 지연을 줄입니다.
  setTimeout(() => {
    warmGneOfficialSearchForm();
  }, 700);

  // 무료 Render에서 유휴 종료를 줄이고 싶을 때만 환경변수로 선택적으로 켭니다.
  startRenderKeepWarm();

  // 실행 중에는 20분마다 백그라운드에서 최신 공식 업무분장으로 갱신합니다.
  const hqRefreshTimer = setInterval(() => {
    refreshGneHqContacts(10000).catch(err => {
      console.error('본청 업무담당자 정기 캐시 오류:', err && err.message ? err.message : err);
    });
  }, 20 * 60 * 1000);
  if (hqRefreshTimer.unref) hqRefreshTimer.unref();
  });
}

startServer().catch(err => {
  console.error('서버 시작 실패:', err && err.stack ? err.stack : err);
  process.exit(1);
});
