// scripts/fetch-matches.mjs
// 拉取世界杯赛程/比分(可选叠加胜率),输出成页面用的 data/matches.json
// 运行: node scripts/fetch-matches.mjs
// 依赖: Node 18+ (内置 fetch),无需 npm 安装

import { writeFile, mkdir } from "node:fs/promises";

// ---- 配置(用环境变量传 key,别写死在代码里)----
const FD_KEY = process.env.FOOTBALL_DATA_KEY;          // football-data.org token(必填)
const FD_COMP = process.env.FD_COMPETITION || "WC";    // FIFA World Cup
const ODDS_KEY = process.env.ODDS_API_KEY || "";       // the-odds-api.com(可选,用于胜率)
const TZ = process.env.DISPLAY_TZ || "America/Vancouver"; // 卡片显示用的时区
const OUT = "data/matches.json";

if (!FD_KEY) {
  console.error("缺少 FOOTBALL_DATA_KEY 环境变量"); process.exit(1);
}

// ---- 1. 拉赛程与比分 ----
async function fetchMatches() {
  const res = await fetch(`https://api.football-data.org/v4/competitions/${FD_COMP}/matches`, {
    headers: { "X-Auth-Token": FD_KEY }
  });
  if (!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`);
  const { matches } = await res.json();
  return matches || [];
}

// football-data 状态 → 看板状态
function mapStatus(s) {
  if (s === "IN_PLAY" || s === "PAUSED") return "in_progress";
  if (s === "FINISHED") return "final";
  if (s === "SCHEDULED" || s === "TIMED") return "scheduled";
  return null; // POSTPONED / SUSPENDED / CANCELLED 等 → 跳过
}

// 格式化成 "6月21日 周日 09:00"
const fmt = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ, month: "numeric", day: "numeric",
  weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
});
function localLabel(iso) {
  // zh-CN 输出形如 "6月21日周日 09:00",补个空格更好看
  return fmt.format(new Date(iso)).replace(/(周.)/, " $1");
}

// ---- 2.(可选)拉赔率并换算成隐含胜率 ----
async function fetchWinProbs() {
  if (!ODDS_KEY) return new Map();
  const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/`
    + `?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=${ODDS_KEY}`;
  const res = await fetch(url);
  if (!res.ok) { console.warn("赔率拉取失败,跳过胜率:", res.status); return new Map(); }
  const events = await res.json();
  const map = new Map();
  for (const ev of events) {
    const bk = ev.bookmakers?.[0]?.markets?.find(m => m.key === "h2h");
    if (!bk) continue;
    const o = {};
    for (const out of bk.outcomes) {
      if (out.name === ev.home_team) o.h = out.price;
      else if (out.name === ev.away_team) o.a = out.price;
      else o.d = out.price; // Draw
    }
    if (!o.h || !o.a || !o.d) continue;
    // 隐含概率 = 1/赔率,再归一化去除博彩抽水(vig)
    const raw = { h: 1/o.h, d: 1/o.d, a: 1/o.a };
    const sum = raw.h + raw.d + raw.a;
    const wp = {
      h: +(raw.h/sum*100).toFixed(1),
      d: +(raw.d/sum*100).toFixed(1),
      a: +(raw.a/sum*100).toFixed(1)
    };
    // 用 "主队名|客队名" 做 key,匹配时按名字包含
    map.set(`${ev.home_team}|${ev.away_team}`, wp);
  }
  return map;
}

function matchWinProb(probMap, homeName, awayName) {
  // 球队未定的场次队名可能为 null,直接跳过避免 .includes 崩溃
  if (!homeName || !awayName) return null;
  for (const [key, wp] of probMap) {
    const [h, a] = key.split("|");
    if (!h || !a) continue;
    if (homeName.includes(h) || h.includes(homeName)) {
      if (awayName.includes(a) || a.includes(awayName)) return wp;
    }
  }
  return null;
}

// ---- 3. 组装并写文件 ----
async function main() {
  const [raw, probMap] = await Promise.all([fetchMatches(), fetchWinProbs()]);

  const games = [];
  for (const m of raw) {
    const status = mapStatus(m.status);
    if (!status) continue;
    // 跳过球队未定的占位场次(淘汰赛对阵还没产生时,队名为 null)
    const hn = m.homeTeam?.shortName || m.homeTeam?.name;
    const an = m.awayTeam?.shortName || m.awayTeam?.name;
    if (!hn || !an) continue;
    const g = {
      status,
      start: m.utcDate,
      h: m.homeTeam.tla || hn,
      a: m.awayTeam.tla || an,
      hn,
      an,
      local: localLabel(m.utcDate)
    };
    if (status === "in_progress" || status === "final") {
      g.hs = m.score?.fullTime?.home ?? 0;
      g.as = m.score?.fullTime?.away ?? 0;
    }
    if (status === "scheduled") {
      const wp = matchWinProb(probMap, g.hn, g.an);
      if (wp) g.wp = wp;
    }
    games.push(g);
  }

  const payload = { snapshot: new Date().toISOString(), games };
  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`已写入 ${OUT}:${games.length} 场比赛`);
}

main().catch(e => { console.error(e); process.exit(1); });
