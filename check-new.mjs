// 의료 판례 모음 - 새 판례 확인 (GitHub Actions에서 매주 실행)
// 하는 일
//   1. 최근 1년 안에 선고된 의료 판례 중 아직 카드로 만들지도, 검토하지도 않은 판례를 찾아요
//   2. 있으면 판결 본문까지 받아 new/batch-날짜.json 으로 저장해요 (워크플로가 저장소에 올려요)
//   3. GitHub 저장소에 "새 의료 판례 N건" 알림 글(Issue)을 올려요. 이메일로 알림이 가요

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";

const OC = (process.env.LAW_OC || "").trim();
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const BASE = "https://www.law.go.kr/DRF";
const DAYS = 365;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (t = "") => console.log(t);

const since = (() => { const d = new Date(Date.now() - DAYS * 86400000); return d.toISOString().slice(0, 10).replace(/-/g, ""); })();

async function getJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      return JSON.parse(await res.text());
    } catch { await sleep(1500 * (i + 1)); }
  }
  return null;
}
function findArray(o) {
  if (Array.isArray(o)) return o;
  if (o && typeof o === "object") for (const v of Object.values(o)) { const a = findArray(v); if (a) return a; }
  return null;
}
function clean(s) {
  return String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
// 긴 판결은 앞(사건 경위)과 뒤(판단·결론)를 함께 남겨요
function excerpt(t, head = 3500, tail = 3000) {
  return t.length <= head + tail + 200 ? t : t.slice(0, head) + "\n…(중략)…\n" + t.slice(-tail);
}

const GROUPS = [
  { kind: "의료사고 민사", query: "손해배상(의)", keep: t => /\(의\)/.test(t) },
  { kind: "의료법 위반", query: "의료법위반", keep: t => /의료법\s*위반/.test(t) },
  { kind: "의료사고 형사", query: "업무상과실치사", keep: t => /업무상\s*과실\s*치(사|상)/.test(t), needMedical: true },
  { kind: "의료사고 형사", query: "업무상과실치상", keep: t => /업무상\s*과실\s*치(사|상)/.test(t), needMedical: true },
  { kind: "건강보험법 위반", query: "국민건강보험법위반", keep: t => /국민건강보험법\s*위반/.test(t), needMedical: true },
  { kind: "의료 행정소송", query: "자격정지처분취소", keep: t => /자격정지/.test(t), needMedical: true },
  { kind: "의료 행정소송", query: "면허취소처분취소", keep: t => /면허/.test(t), needMedical: true },
  { kind: "의료 행정소송", query: "업무정지처분취소", keep: t => /업무정지/.test(t), needMedical: true },
  { kind: "의료 행정소송", query: "요양급여비용", keep: t => /요양급여/.test(t), needMedical: true },
  { kind: "의료 행정소송", query: "부당이득금", keep: t => /부당이득/.test(t), needMedical: true }
];
const MEDICAL = /의사|병원|의원|의료|환자|수술|진료|간호사|시술|요양급여|요양기관/g;

async function main() {
  if (!OC) { log("LAW_OC가 없어요. GitHub Secrets에 법제처 인증키를 넣어 주세요."); process.exit(1); }

  const known = new Set();
  const js = await readFile("cases.js", "utf8").catch(() => "");
  for (const m of js.matchAll(/id:\s*"([^"]+)"/g)) known.add(m[1]);
  const sk = await readFile("skipped.txt", "utf8").catch(() => "");
  sk.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith("#")).forEach(x => known.add(x));
  // 이미 new 폴더에 저장돼 정리를 기다리는 판례도 다시 알리지 않아요
  try {
    for (const f of await readdir("new")) {
      if (!f.endsWith(".json")) continue;
      for (const c of JSON.parse(await readFile(`new/${f}`, "utf8"))) known.add(String(c.id));
    }
  } catch { /* 아직 없음 */ }
  log(`이미 아는 판례 ${known.size}건, ${since} 이후 선고된 판례를 확인해요.`);

  const found = new Map();
  for (const g of GROUPS) {
    const q = new URLSearchParams({ OC, target: "prec", type: "JSON", search: "1", query: g.query, display: "100", page: "1", sort: "ddes" });
    const j = await getJson(`${BASE}/lawSearch.do?${q}`);
    const items = findArray(j) ?? [];
    for (const x of items) {
      const id = String(x["판례일련번호"] || "");
      const date = String(x["선고일자"] || "").replace(/\D/g, "");
      const title = String(x["사건명"] || "");
      if (!id || known.has(id) || found.has(id)) continue;
      if (date < since) continue;
      if (/국세|지방세/.test(x["데이터출처명"] || "")) continue;
      if (!g.keep(title)) continue;
      const d = await getJson(`${BASE}/lawService.do?${new URLSearchParams({ OC, target: "prec", type: "JSON", ID: id })}`);
      await sleep(300);
      const body = d ? Object.values(d).find(v => v && typeof v === "object" && !Array.isArray(v)) : null;
      if (!body || body.Law || body["판례내용"] === undefined) continue;
      const text = clean(body["판례내용"]);
      if (g.needMedical && (text.match(MEDICAL) || []).length < 8) continue;
      found.set(id, {
        id, kind: g.kind, caseNo: body["사건번호"] || x["사건번호"] || "", title: clean(body["사건명"] || title),
        court: body["법원명"] || x["법원명"] || "", date: String(body["선고일자"] || date).replace(/\D/g, ""),
        판시사항: clean(body["판시사항"]), 판결요지: clean(body["판결요지"]), 참조조문: clean(body["참조조문"]).slice(0, 300),
        판례내용: excerpt(text)
      });
    }
    await sleep(300);
  }

  const list = [...found.values()].sort((a, b) => b.date.localeCompare(a.date));
  log(`새 판례 ${list.length}건`);
  list.forEach(c => log(`  ${c.date} ${c.court} ${c.caseNo} ${c.title} (번호 ${c.id})`));
  if (!list.length) return;

  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const file = `new/batch-${today}.json`;
  await mkdir("new", { recursive: true });
  await writeFile(file, JSON.stringify(list, null, 1), "utf8");
  log(`${file} 에 저장했어요.`);
  if (!TOKEN || !REPO) return;

  const owner = REPO.split("/")[0];
  const body = [
    `@${owner} 아직 카드로 만들지 않은 의료 판례가 새로 확인됐어요.`,
    "",
    "**할 일:** Claude의 \"의료 판례 모음\" 프로젝트에서 새 대화를 열고 **새 판례 정리해줘**라고 말해 주세요.",
    `판례 본문은 저장소의 \`${file}\`에 저장돼 있어서 따로 올릴 파일은 없어요.`,
    "",
    ...list.map(c => `- ${c.date.slice(0, 4)}.${c.date.slice(4, 6)}.${c.date.slice(6, 8)} ${c.court} ${c.caseNo} ${c.title} (판례번호 ${c.id})`)
  ].join("\n");
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: `새 의료 판례 ${list.length}건 (${today})`, body })
  });
  log(res.ok ? "알림 글을 올렸어요." : `알림 글 올리기 실패: ${res.status} ${await res.text()}`);
}

main();
