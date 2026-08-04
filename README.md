# 경남교육청 1004챗봇 백엔드

카카오톡 챗봇 폴백 스킬 + 웹챗봇의 로그/학습을 모두가 공유하도록 저장해주는 아주 작은 서버입니다.
데이터베이스 없이 JSON 파일 3개(`data/scenarios.json`, `data/missed.json`, `data/learned.json`)로만 동작해서,
운영이 단순합니다.

## 1. 로컬에서 먼저 테스트해보기

컴퓨터에 Node.js가 설치되어 있어야 합니다 (없다면 https://nodejs.org 에서 LTS 버전 설치).

```
cd server
npm install
ADMIN_TOKEN=원하는비밀번호 npm start
```

`서버 실행 중: http://localhost:3000` 이 뜨면 성공입니다. 브라우저로 http://localhost:3000 을 열어서
"...정상적으로 실행 중입니다" 문구가 보이면 잘 된 거예요.

## 2. 실제로 인터넷에 올리기 (배포)

로컬 컴퓨터는 끄면 서버도 같이 꺼지기 때문에, 24시간 켜져 있는 곳에 올려야 실제로 쓸 수 있어요.
선택지는 두 가지예요.

**A. 경남교육청 자체 서버 (권장, 정식 운영용)**
Node.js가 설치된 서버라면 이 폴더를 그대로 올리고 `npm install && npm start`만 실행하면 됩니다.
민원인 관련 데이터가 교육청 인프라 밖으로 나가지 않는다는 장점이 있어요. 전산 담당 부서에
이 폴더를 전달하고 "Node.js Express 서버 하나 띄워달라"고 요청하시면 됩니다.

**B. 무료 클라우드 (테스트/임시용) — 예: Render.com**
1. https://render.com 가입 (깃허브 계정으로 가입 가능)
2. 이 `server` 폴더를 깃허브 저장소에 올리기
3. Render에서 "New Web Service" → 그 저장소 선택
4. Build Command: `npm install` / Start Command: `npm start`
5. Environment Variables에 `ADMIN_TOKEN` 추가 (원하는 비밀번호로)
6. 배포되면 `https://xxxxx.onrender.com` 같은 주소가 생김 — 이게 API_BASE

⚠️ 위에서 만든 서버 주소는 외부(구글 등)와 무관하게, 배포한 곳(Render든 교육청 서버든)의
정책을 따릅니다. 교육청 컴퓨터에서 특정 사이트가 막혀 있다면, 그 사이트에서 "가입/설정"하는
과정 자체가 막힐 수 있어요 — 이 경우 개인 기기나 다른 네트워크에서 배포 작업을 하시고,
운영은 A안(교육청 자체 서버)으로 가는 걸 권장드려요.

## 3. 웹챗봇과 연결하기

`경남교육청_1004챗봇_웹버전.html` 파일을 열어서 `API_BASE = ''` 부분을 찾아
배포한 주소로 바꿔주세요:

```js
const API_BASE = 'https://xxxxx.onrender.com';
```

그 다음 파일을 다시 저장하고 웹서버에 올리면, 로그와 학습 내용이 이제 이 서버에 쌓입니다.
`?admin=1`로 관리자 패널을 열면 서버 연결 여부와 "관리자 토큰" 입력칸이 보여요 — 여기에
위에서 정한 `ADMIN_TOKEN` 값을 넣어야 학습 기능이 서버에도 저장됩니다.

## 4. 카카오톡 오픈빌더에 연결하기 (폴백 스킬)

1. 오픈빌더 관리자센터 → 좌측 메뉴에서 **스킬** → **스킬 추가**
2. URL에 `https://여러분의서버주소/api/kakao-skill` 입력 → 저장
3. **폴백 블록**으로 이동 → 응답을 "스킬"로 설정하고, 방금 만든 스킬 선택
4. 저장 후 **배포** 버튼을 눌러야 실제 채널에 반영됩니다

이렇게 하면, 기존 오픈빌더 패턴 매칭이 실패했을 때만 이 서버가 대신 답을 찾아줍니다.
기존에 잘 동작하던 328개 발화·104개 블록은 그대로 유지되고, 이 서버는 "그래도 모르겠을 때"의
안전망 역할만 합니다.

## API 목록

| 메서드 | 경로 | 용도 | 인증 |
|---|---|---|---|
| GET | /api/scenarios | 전체 시나리오 데이터 | 없음 |
| GET | /api/learned | 학습된 표현 목록 (읽기전용) | 없음 |
| POST | /api/match | `{query}` → 매칭 결과 | 없음 |
| POST | /api/log | 놓친 질문 기록 | 없음 |
| POST | /api/kakao-skill | 카카오 폴백 스킬 웹훅 | 없음 (카카오 서버만 호출) |
| GET | /api/admin/missed | 놓친 질문 전체 목록 | `x-admin-token` 헤더 |
| DELETE | /api/admin/missed | 놓친 질문 전체 삭제 | `x-admin-token` 헤더 |
| POST | /api/learn | `{text, blockIdx}` 학습 추가 | `x-admin-token` 헤더 |
| DELETE | /api/learn/:i | 학습 항목 삭제 | `x-admin-token` 헤더 |

## 시나리오 데이터가 나중에 바뀌면?

오픈빌더에서 시나리오를 수정하고 새 HTML 내보내기 파일을 저에게 다시 주시면, 같은 방식으로
`data/scenarios.json`을 새로 만들어 드릴게요. 그 파일만 교체하고 서버를 재시작하면 반영됩니다.
