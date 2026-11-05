# GYBM 홀덤 테이블 (온라인)

링크만 있으면 최대 5명이 각자 폰으로 접속해서 치는 텍사스 홀덤.

- 로그인 없음: **닉네임 + PIN 4자리**로 입장, 칩은 서버에 저장
- 카드는 서버가 돌림: 상대 패는 쇼다운 전까지 기기로 전송되지 않음
- 랭킹 (칩 / 손익 / 승률 / 파산 횟수)
- 파산하면 시작 칩의 50%로 복구 가능 (관리자가 비율 변경 가능)
- 차례 제한 시간(기본 30초) 지나면 자동 체크/폴드, 2번 연속이면 자리비움 처리
- **AI 플레이어 "AI 알파"가 늘 한 자리에 앉아 있음**: 혼자 들어와도 바로 1:1, 4명이 앉으면 자리를 비켜줌, 파산하면 알아서 리바이 (방장 설정에서 끄기 가능, 랭킹엔 안 들어감)
- **방장 = 맨 처음 가입한 사람** (관리자 비밀번호 필요 없음, 방장 넘기기 가능)
- 방장 설정: 시작 칩·블라인드·복구 비율·제한 시간, 칩 수정, PIN 초기화, 계정 삭제, 전체 초기화

---

## 배포하기 (무료, 약 10분)

필요한 것: GitHub 계정. Neon과 Render는 GitHub 계정으로 가입할 수 있어.

### 1. GitHub에 코드 올리기
1. github.com → 오른쪽 위 **+** → **New repository** → 이름 `holdem-online`, **Private**으로 만들어도 됨 → Create
2. 생성된 페이지에서 **uploading an existing file** 클릭
3. 압축 푼 폴더 안의 파일을 전부 끌어다 놓기
   (`server.js`, `engine.js`, `ai.js`, `store.js`, `index.html`, `package.json`, `README.md`, `.gitignore`)
4. **Commit changes**

### 2. Neon에서 무료 DB 만들기 (칩 저장용)
1. neon.tech → GitHub로 가입 (카드 등록 필요 없음)
2. **Create project** → Region은 **AWS Asia Pacific (Singapore)** 추천 (베트남·한국에서 가까움)
3. 대시보드의 **Connect** → 연결 문자열 복사
   `postgresql://...@....neon.tech/neondb?sslmode=require` 같은 모양

> Render 무료 서버는 재시작할 때 디스크가 초기화되고, Render 무료 DB는 30일 뒤 만료돼서 칩 저장은 Neon을 써.

### 3. Render에 서버 띄우기
1. render.com → GitHub로 가입
2. **New +** → **Web Service** → 방금 만든 `holdem-online` 저장소 선택
3. 설정
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Region: **Singapore**
   - Instance Type: **Free**
4. **Environment Variables**에 하나 추가
   - `DATABASE_URL` = 2번에서 복사한 Neon 연결 문자열
5. **Create Web Service** → 몇 분 뒤 `https://holdem-online-xxxx.onrender.com` 같은 주소가 생김
6. **친구들한테 보내기 전에 네가 먼저 입장해.** 맨 처음 가입한 사람이 방장이 돼.
7. 이 주소를 친구들한테 보내면 끝

### 알아둘 것
- Render 무료 서버는 **15분 동안 아무도 없으면 잠들고**, 다음 접속 때 깨어나는 데 **1분쯤** 걸려. 게임 중엔 계속 깨어 있음.
- 서버가 재시작돼도 칩은 Neon에 저장돼 있어서 그대로야. 핸드 도중에 재시작되면 그 핸드는 무효 처리되고 건 칩은 돌려받아.
- 방장 설정: 게임 화면 **메뉴 → 방장 설정**.
- PIN을 까먹은 친구는 방장이 **새 PIN**으로 바꿔주면 돼.

---

## 내 컴퓨터에서 실행 (테스트용)

```bash
npm install
npm start
```

`http://localhost:3000` 접속. `DATABASE_URL`이 없으면 칩을 `data.json` 파일에 저장해.
같은 Wi-Fi에 있는 폰은 `http://내컴퓨터IP:3000`으로 들어올 수 있어.

| 환경변수 | 설명 | 기본값 |
|---|---|---|
| `DATABASE_URL` | Postgres 연결 문자열 (Neon) | 없으면 `data.json` 파일 |
| `ADMIN_KEY` | (선택) 방장이 아니어도 설정을 열 수 있는 비상용 키 | 없음 |
| `PORT` | 서버 포트 | 3000 (Render는 자동 지정) |
