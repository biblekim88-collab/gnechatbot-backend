// 경남교육청 1004챗봇 백엔드 서버
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

// 학습된 표현을 매칭 대상에 실시간으로 합쳐서 사용
function getEffectiveUtterances() {
  const learned = readJson(LEARNED_PATH, []);
  const merged = BLOCKS.map(b => ({ ...b, utterances: [...b.utterances] }));
  learned.forEach(e => {
    if (merged[e.blockIdx] && !merged[e.blockIdx].utterances.includes(e.text)) {
      merged[e.blockIdx].utterances.push(e.text);
    }
  });
  return merged;
}

// ---- 동의어 사전 (웹버전과 동일 — 필요하면 여기서도 계속 늘리면 됨) ----
const SYNONYMS = {
  '졸업장':'졸업증명서', '생기부':'생활기록부', '성적표':'성적증명서',
  '재적':'제적증명서', '정원외':'정원외관리증명서', '퇴직증명':'퇴직증명원',
  '영문성적표':'영문증명서', '영문졸업장':'영문증명서',
  '전학':'전입학', '배정':'재배정', '재배정계획':'재배정',
  '수능접수':'수능원서접수', '수능원서':'수능원서접수',
  '꿈디딤':'꿈디딤카드', '다자녀':'다자녀카드사업안내',
  '채용':'교육공무직원 채용 안내', '공무직채용':'교육공무직원 채용 안내',
  '학원등록':'학원안내', '교습소':'학원안내',
  '팩스':'팩스민원', '신문고':'국민신문고', '정보공개':'정보공개청구',
  '아이북':'아이톡톡아이북', '자격증재교부':'교원자격증 재교부',
  '검고':'검정고시'
};
function expandQuery(q) {
  let extra = '';
  Object.keys(SYNONYMS).forEach(k => { if (q.includes(k)) extra += ' ' + SYNONYMS[k]; });
  return q + extra;
}

// ---- 한글 자모 분해 (오타 대응) ----
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
function decomposeHangul(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const si = code - 0xAC00;
      out += CHO[Math.floor(si/588)] + JUNG[Math.floor((si%588)/28)] + JONG[si%28];
    } else out += ch;
  }
  return out;
}
function bigrams(s) {
  s = s.replace(/\s+/g,'');
  const m = new Map();
  for (let i=0;i<s.length-1;i++){ const g=s.substr(i,2); m.set(g,(m.get(g)||0)+1); }
  return m;
}
function dice(a,b) {
  const da = decomposeHangul(a.replace(/\s+/g,''));
  const db = decomposeHangul(b.replace(/\s+/g,''));
  const A = bigrams(da), B = bigrams(db);
  if (A.size===0 || B.size===0) return da===db ? 1 : 0;
  let overlap=0, totalA=0, totalB=0;
  A.forEach(v=>totalA+=v); B.forEach(v=>totalB+=v);
  A.forEach((v,k)=>{ if (B.has(k)) overlap += Math.min(v,B.get(k)); });
  return (2*overlap)/(totalA+totalB);
}
function containScore(q,u) {
  q=q.replace(/\s+/g,''); u=u.replace(/\s+/g,'');
  if (!q||!u) return 0;
  const shorter = q.length <= u.length ? q : u;
  const longer = q.length <= u.length ? u : q;
  if (shorter.length < 3) return 0; // 너무 짧은 조각(1~2자)은 우연히 겹치기 쉬워서 포함매칭 보너스 제외
  if (longer.includes(shorter)) return 0.55 + 0.25*(shorter.length/longer.length);
  return 0;
}
function scoreAgainst(query, target) {
  return Math.max(dice(query,target), containScore(query,target));
}
function findBestBlock(rawQuery, blocks) {
  const query = expandQuery(rawQuery);
  let best = { idx: -1, score: 0 };
  blocks.forEach((b,i) => {
    let s = scoreAgainst(query, b.title) * 0.9;
    b.utterances.forEach(u => { s = Math.max(s, scoreAgainst(query, u)); });
    if (s > best.score) best = { idx: i, score: s };
  });
  return best;
}
function topCandidates(rawQuery, blocks, n) {
  const query = expandQuery(rawQuery);
  const scored = blocks.map((b,i) => {
    let s = scoreAgainst(query, b.title) * 0.9;
    b.utterances.forEach(u => { s = Math.max(s, scoreAgainst(query, u)); });
    return { idx:i, score:s };
  });
  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,n).filter(c=>c.score>0.12);
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
  const best = findBestBlock(query, blocks);
  if (best.idx === -1 || best.score < 0.30) {
    logMissed(query, best.idx>=0 ? blocks[best.idx].title : '', best.score);
    return res.json({ matched: false, fallback: BLOCKS[FALLBACK_IDX], candidates: topCandidates(query, blocks, 3).map(c=>({title:blocks[c.idx].title, idx:c.idx})) });
  }
  res.json({ matched: true, idx: best.idx, score: best.score, block: BLOCKS[best.idx] });
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
// 오픈빌더 > 스킬 관리 > 새 스킬 등록 시 이 주소를 URL로 등록하고,
// 폴백 블록의 응답을 "스킬"로 설정하면 됩니다.
app.post('/api/kakao-skill', (req, res) => {
  const utterance = (req.body && req.body.userRequest && req.body.userRequest.utterance) || '';
  const kakaoUserId = (req.body && req.body.userRequest && req.body.userRequest.user && req.body.userRequest.user.id) || '';
  const blocks = getEffectiveUtterances();
  const best = findBestBlock(utterance, blocks);

  if (best.idx === -1 || best.score < 0.30) {
    logMissed(utterance, best.idx>=0 ? blocks[best.idx].title : '', best.score);
    trackQuery(utterance, best.idx>=0 ? blocks[best.idx].title : '', false, 'kakao', 'kakao:'+kakaoUserId);
    const cands = topCandidates(utterance, blocks, 3);
    return res.json({
      version: '2.0',
      template: {
        outputs: [{ simpleText: { text: '제가 질문을 잘 이해하지 못했어요😥\n조금 더 구체적으로 말씀해주시거나, 아래 항목 중에 골라주세요.' } }],
        quickReplies: cands.map(c => ({ label: blocks[c.idx].title, action: 'message', messageText: blocks[c.idx].title }))
          .concat([{ label: '☎ 콜센터 연결', action: 'message', messageText: '콜센터' }])
      }
    });
  }

  trackQuery(utterance, blocks[best.idx].title, true, 'kakao', 'kakao:'+kakaoUserId);
  const block = blocks[best.idx];
  const outputs = [];
  block.responses.forEach(r => {
    outputs.push({ simpleText: { text: r.message } });
    const urlPhoneButtons = (r.buttons||[]).filter(b => b.type==='url' || b.type==='phone').map(b => {
      if (b.type === 'url') return { action: 'webLink', label: b.label, webLinkUrl: b.value };
      return { action: 'phone', label: b.label, phoneNumber: b.value };
    });
    if (urlPhoneButtons.length) {
      outputs.push({ basicCard: { title: block.title, description: ' ', buttons: urlPhoneButtons } });
    }
  });

  const quickReplies = [];
  (block.quick_replies||[]).forEach(qr => quickReplies.push({ label: qr.label, action: 'message', messageText: qr.label }));
  block.responses.forEach(r => (r.buttons||[]).forEach(b => {
    if (b.type === 'block') quickReplies.push({ label: b.label, action: 'message', messageText: b.label });
  }));

  res.json({ version: '2.0', template: { outputs, quickReplies: quickReplies.slice(0,10) } });
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
