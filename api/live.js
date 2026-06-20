// api/live.js — Vercel Serverless Function
// 实时返回"进行中"的比赛比分,供前端高频轮询(绕开 GitHub Actions 5 分钟的慢链路)。
// key 放在服务端环境变量里,绝不暴露给浏览器;边缘缓存 15s 共享给所有访客,
// 把 football-data 免费档的限流(10 次/分钟)压到最多 4 次/分钟。
//
// 部署:把本仓库导入 Vercel,在项目 Settings → Environment Variables 里
//       加 FOOTBALL_DATA_KEY(可选 FD_COMPETITION,默认 WC)。

const FD_COMP = process.env.FD_COMPETITION || "WC";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // 允许 GitHub Pages 跨域调用
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");

  const key = process.env.FOOTBALL_DATA_KEY;
  if (!key) {
    res.status(500).json({ error: "missing FOOTBALL_DATA_KEY" });
    return;
  }

  try {
    const r = await fetch(
      `https://api.football-data.org/v4/competitions/${FD_COMP}/matches`,
      { headers: { "X-Auth-Token": key } }
    );
    if (!r.ok) {
      res.status(502).json({ error: `football-data ${r.status}` });
      return;
    }
    const { matches = [] } = await r.json();

    const games = [];
    for (const m of matches) {
      // 只要进行中的(IN_PLAY / 中场 PAUSED)
      if (m.status !== "IN_PLAY" && m.status !== "PAUSED") continue;
      // 跳过球队未定的占位场次
      const hn = m.homeTeam?.shortName || m.homeTeam?.name;
      const an = m.awayTeam?.shortName || m.awayTeam?.name;
      if (!hn || !an) continue;
      games.push({
        status: "in_progress",
        start: m.utcDate, // 与 matches.json 的 start 一致,前端按此匹配卡片
        h: m.homeTeam.tla || hn,
        a: m.awayTeam.tla || an,
        hn,
        an,
        hs: m.score?.fullTime?.home ?? 0,
        as: m.score?.fullTime?.away ?? 0,
      });
    }

    res.status(200).json({ snapshot: new Date().toISOString(), games });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
