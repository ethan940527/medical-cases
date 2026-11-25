// 의료 판례 모음 - 새 판례 확인 (GitHub Actions에서 매달 실행)
// 하는 일: 최근 6개월 안에 선고된 의료 판례 중 아직 카드로 만들지도, 검토하지도 않은 판례를 찾아
//          있으면 GitHub 저장소에 "새 의료 판례 N건" 알림 글(Issue)을 올려요. 그러면 이메일로 알림이 가요.

import { readFile } from "node:fs/promises";

const OC = (process.env.LAW_OC || "").trim();
const TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const BASE = "https://www.law.go.kr/DRF";
const DAYS = 180;
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
function clean(s) { return String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

const GROUPS = [
  { query: "손해배상(의)", keep: t => /\(의\)/.test(t) },
  { query: "의료법위반", keep: t => /의료법\s*위반/.test(t) },
  { query: "업무상과실치사", keep: t => /업무상\s*과실\s*치(사|상)/.test(t), needMedical: true },
  { query: "업무상과실치상", keep: t => /업무상\s*과실\s*치(사|상)/.test(t), needMedical: true },
  { query: "국민건강보험법위반", keep: t => /국민건강보험법\s*위반/.test(t), needMedical: true },
  { query: "자격정지처분취소", keep: t => /자격정지/.test(t), needMedical: true },
  { query: "면허취소처분취소", keep: t => /면허/.test(t), needMedical: true },
  { query: "업무정지처분취소", keep: t => /업무정지/.test(t), needMedical: true },
  { query: "요양급여비용", keep: t => /요양급여/.test(t), needMedical: true },
  { query: "부당이득금", keep: t => /부당이득/.test(t), needMedical: true }
];
const MEDICAL = /의사|병원|의원|의료|환자|수술|진료|간호사|시술|요양급여|요양기관/g;

async function main() {
  if (!OC) { log("LAW_OC가 없어요. GitHub Secrets에 법제처 인증키를 넣어 주세요."); process.exit(1); }

  const known = new Set();
  const js = await readFile("cases.js", "utf8").catch(() => "");
  for (const m of js.matchAll(/id:\s*"([^"]+)"/g)) known.add(m[1]);
  const sk = await readFile("skipped.txt", "utf8").catch(() => "");
  sk.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith("#")).forEach(x => known.add(x));
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
      if (g.needMedical) {
        const d = await getJson(`${BASE}/lawService.do?${new URLSearchParams({ OC, target: "prec", type: "JSON", ID: id })}`);
        const body = d ? Object.values(d).find(v => v && typeof v === "object" && !Array.isArray(v)) : null;
        const text = clean(body?.["판례내용"]);
        if ((text.match(MEDICAL) || []).length < 8) continue;
        await sleep(300);
      }
      found.set(id, { id, date, court: x["법원명"] || "", caseNo: x["사건번호"] || "", title: clean(title) });
    }
    await sleep(300);
  }

  const list = [...found.values()].sort((a, b) => b.date.localeCompare(a.date));
  log(`새 판례 ${list.length}건`);
  list.forEach(c => log(`  ${c.date} ${c.court} ${c.caseNo} ${c.title} (번호 ${c.id})`));
  if (!list.length || !TOKEN || !REPO) return;

  const body = [
    "아직 카드로 만들지 않은 의료 판례가 새로 확인됐어요.",
    "",
    "**다음에 할 일:** 내 컴퓨터 `panrye` 폴더에서 `node collect-panrye.mjs ethan940527`을 실행하고, 새로 만들어진 batch 파일을 의료 판례 모음 프로젝트에 올려 주세요.",
    "",
    ...list.map(c => `- ${c.date.slice(0, 4)}.${c.date.slice(4, 6)}.${c.date.slice(6, 8)} ${c.court} ${c.caseNo} ${c.title} (판례번호 ${c.id})`)
  ].join("\n");
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: `새 의료 판례 ${list.length}건`, body })
  });
  log(res.ok ? "알림 글을 올렸어요." : `알림 글 올리기 실패: ${res.status} ${await res.text()}`);
}

main();
