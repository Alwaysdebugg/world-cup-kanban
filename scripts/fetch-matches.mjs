// scripts/fetch-matches.mjs
// 拉取世界杯赛程/比分(可选叠加胜率),输出成页面用的 data/matches.json
// 运行: node scripts/fetch-matches.mjs
// 依赖: Node 18+ (内置 fetch),无需 npm 安装

import { writeFile, readFile, mkdir } from "node:fs/promises";

// ---- 配置(用环境变量传 key,别写死在代码里)----
const FD_KEY = process.env.FOOTBALL_DATA_KEY;          // football-data.org token(必填)
const FD_COMP = process.env.FD_COMPETITION || "WC";    // FIFA World Cup
const ODDS_KEY = process.env.ODDS_API_KEY || "";       // the-odds-api.com(可选,用于胜率)
const TZ = process.env.DISPLAY_TZ || "America/Vancouver"; // 卡片显示用的时区
const OUT = "data/matches.json";
// 比分每次运行都刷新(CI 约 5 分钟一跑);但 odds 单独限流:距上次拉取不满
// ODDS_INTERVAL_MIN 分钟就复用上次胜率,不再调 the-odds-api(省配额)。
const ODDS_INTERVAL_MIN = +(process.env.ODDS_INTERVAL_MIN || 10);

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

// ---- 拉小组积分榜 ----
async function fetchStandings() {
  const res = await fetch(`https://api.football-data.org/v4/competitions/${FD_COMP}/standings`, {
    headers: { "X-Auth-Token": FD_KEY }
  });
  if (!res.ok) { console.warn("积分榜拉取失败,跳过:", res.status); return []; }
  const { standings = [] } = await res.json();
  const groups = [];
  for (const s of standings) {
    if (s.type !== "TOTAL" || !s.group) continue; // 只要小组赛总榜,淘汰赛(group 为 null)跳过
    groups.push({
      group: s.group.replace(/^GROUP_/, ""), // "GROUP_A" → "A"
      table: (s.table || []).map(r => ({
        pos: r.position,
        tla: r.team?.tla || r.team?.shortName || r.team?.name,
        name: r.team?.shortName || r.team?.name,
        p: r.playedGames, w: r.won, d: r.draw, l: r.lost,
        gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference,
        pts: r.points
      }))
    });
  }
  return groups;
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

// 读取上一份 data/matches.json(用于 odds 限流与复用上次胜率);不存在/损坏返回 null
async function readPrev() {
  try {
    return JSON.parse(await readFile(OUT, "utf8"));
  } catch {
    return null;
  }
}

// ---- 3. 组装并写文件 ----
async function main() {
  const prev = await readPrev();
  const now = Date.now();

  // 是否需要重新拉 odds:有 key 且距上次拉取已满阈值(留 1 分钟余量抗 cron 抖动)
  const prevOddsAt = prev?.oddsAt ? new Date(prev.oddsAt).getTime() : 0;
  const oddsThresholdMs = Math.max(0, ODDS_INTERVAL_MIN - 1) * 60 * 1000;
  const refreshOdds = !!ODDS_KEY && (now - prevOddsAt >= oddsThresholdMs);

  // 比分、积分榜每次都拉;odds 仅在到点时才拉,否则沿用上次结果
  const [raw, standings, freshProb] = await Promise.all([
    fetchMatches(),
    fetchStandings(),
    refreshOdds ? fetchWinProbs() : Promise.resolve(null)
  ]);
  const oddsAt = refreshOdds ? new Date(now).toISOString() : (prev?.oddsAt || null);

  // 上次各场的胜率,按 "主TLA|客TLA" 建索引,供本次复用/兜底
  const prevWp = new Map();
  for (const pg of prev?.games || []) {
    if (pg.wp) prevWp.set(`${pg.h}|${pg.a}`, pg.wp);
  }

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
      // 本轮拉到新 odds 就用新的;没拉(限流中)或没匹配到则沿用上次胜率
      let wp = freshProb ? matchWinProb(freshProb, g.hn, g.an) : null;
      if (!wp) wp = prevWp.get(`${g.h}|${g.a}`) || null;
      if (wp) g.wp = wp;
    }
    games.push(g);
  }

  const payload = { snapshot: new Date().toISOString(), oddsAt, games, standings };
  await mkdir("data", { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`已写入 ${OUT}:${games.length} 场比赛、${standings.length} 个小组积分榜(odds ${refreshOdds ? "已刷新" : "复用上次"})`);
}

main().catch(e => { console.error(e); process.exit(1); });
