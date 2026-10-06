/**
 * Deterministic TikTok look-alike for offline derivation + CI. It reproduces the parts of
 * tiktok.com's DOM contract the profile flow depends on (data-e2e attributes, emotion-style
 * `css-<hash>-SemanticName` classes, infinite-scroll grid, video detail page with a canvas,
 * __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON) so one manifest runs against both.
 *
 *   tsx fixtures/tiktok-mock/server.ts [port]
 */
import { createServer, type Server } from "node:http";

const PER_PAGE = 12;
const TOTAL = 40;

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 2 ** 32;
}
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
const TAGS = ["fyp", "foryou", "cooking", "recipe", "travel", "dance", "comedy", "diy", "tech", "music", "pets", "fitness"];
const WORDS = ["quick", "dinner", "hack", "you", "need", "trying", "this", "again", "best", "ever", "wait", "for", "it", "day", "in", "my", "life"];

export interface MockVideo {
  id: string; desc: string; hashtags: string[]; createTime: number; cover: string;
  stats: { playCount: number; diggCount: number; commentCount: number; shareCount: number; collectCount: number };
  music: { title: string; authorName: string; original: boolean }; duration: number;
}
export interface MockUser {
  id: string; uniqueId: string; nickname: string; signature: string; verified: boolean;
  stats: { followerCount: number; followingCount: number; heart: number; videoCount: number };
}

export function mockUser(name: string): { user: MockUser; videos: MockVideo[] } {
  const r = rng(name);
  const videos: MockVideo[] = Array.from({ length: TOTAL }, (_, i) => {
    const tags = [pick(r, TAGS), pick(r, TAGS), "fyp"].filter((t, j, a) => a.indexOf(t) === j);
    const id = String(7300000000000000000n + BigInt(Math.floor(r() * 1e12)) * 1000n + BigInt(i));
    return {
      id,
      desc: Array.from({ length: 5 + Math.floor(r() * 6) }, () => pick(r, WORDS)).join(" "),
      hashtags: tags,
      createTime: 1735689600 - i * 86400 * 2 - Math.floor(r() * 80000),
      cover: `/img/cover/${id}.svg`,
      stats: {
        playCount: Math.floor(r() * 5e6) + 1000, diggCount: Math.floor(r() * 4e5), commentCount: Math.floor(r() * 9000),
        shareCount: Math.floor(r() * 20000), collectCount: Math.floor(r() * 30000),
      },
      music: { title: r() > 0.5 ? `original sound - ${name}` : `${pick(r, WORDS)} ${pick(r, WORDS)}`, authorName: name, original: r() > 0.5 },
      duration: 8 + Math.floor(r() * 50),
    };
  });
  const user: MockUser = {
    id: String(6800000000000000000n + BigInt(Math.floor(r() * 1e15))),
    uniqueId: name, nickname: name.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    signature: `${pick(r, WORDS)} ${pick(r, WORDS)} creator · ${pick(r, TAGS)} 🍜`, verified: r() > 0.5,
    stats: { followerCount: Math.floor(r() * 9e6), followingCount: Math.floor(r() * 900), heart: Math.floor(r() * 2e8), videoCount: TOTAL },
  };
  return { user, videos };
}

/** TikTok-style abbreviations: 1234 → "1234", 12345 → "12.3K", 1234567 → "1.2M". */
export function abbr(n: number): string {
  if (n < 10000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmtDate = (t: number) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; };

function tile(user: string, v: MockVideo) {
  return `<div data-e2e="user-post-item" class="css-x6y88p-DivItemContainerV2 e19c29qe8">
  <div class="css-1as5cen-DivWrapper"><a href="/@${user}/video/${v.id}" class="css-1g95xhm-AVideoContainer">
    <div class="css-41hm0z-DivPlayerContainer"><picture><img alt="${esc(v.desc)} ${v.hashtags.map((t) => "#" + t).join(" ")}" src="${v.cover}" loading="lazy" class="css-1itcwxg-ImgPoster"></picture>
    <div class="css-11u47i-DivCardFooter"><svg width="18" height="18" viewBox="0 0 48 48"><path d="M16 10v28l22-14z" fill="#fff"/></svg><strong data-e2e="video-views" class="video-count css-dirst9-StrongVideoCount">${abbr(v.stats.playCount)}</strong></div></div>
  </a></div></div>`;
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#161823}
.css-hdr-DivHeaderWrapper{position:sticky;top:0;height:60px;display:flex;align-items:center;gap:24px;padding:0 24px;border-bottom:1px solid #eee;background:#fff;z-index:5}
.logo{font-weight:800;font-size:22px}.css-srch-DivSearchFormContainer input{width:360px;padding:10px 16px;border-radius:92px;border:0;background:#f1f1f2}
main{max-width:1100px;margin:0 auto;padding:32px 24px}
.css-1o9t6sm-DivShareInfo{display:flex;gap:28px;align-items:center}
.css-1zpj2q-ImgAvatar{width:116px;height:116px;border-radius:50%;display:block}
h1[data-e2e=user-title]{font-size:32px;margin:0}h2[data-e2e=user-subtitle]{font-size:18px;font-weight:600;margin:4px 0}
.css-1ldzp5s-DivNumber{display:inline-flex;gap:6px;margin-right:20px;font-size:17px}.css-1ldzp5s-DivNumber span{color:#555}
h2[data-e2e=user-bio]{font-weight:400;font-size:16px;margin:10px 0 0}
.css-1qb12g8-DivThreeColumnContainer{margin-top:32px}
[data-e2e=user-post-item-list]{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px 12px}
.css-41hm0z-DivPlayerContainer{position:relative;aspect-ratio:3/4;border-radius:6px;overflow:hidden;background:#222}
.css-41hm0z-DivPlayerContainer img{width:100%;height:100%;object-fit:cover;display:block}
.css-11u47i-DivCardFooter{position:absolute;left:8px;bottom:8px;display:flex;gap:4px;align-items:center;color:#fff;font-size:15px}
.loader{padding:24px;text-align:center;color:#999}
.css-video-DivBrowserModeContainer{display:grid;grid-template-columns:1fr 420px;height:calc(100vh - 60px)}
.css-video-DivVideoContainer{background:#111;display:flex;align-items:center;justify-content:center;position:relative}
.css-video-DivVideoContainer canvas{height:90%;aspect-ratio:9/16;border-radius:8px}
[data-e2e=browse-close]{position:absolute;top:16px;left:16px;width:40px;height:40px;border-radius:50%;border:0;background:#fff3;color:#fff;font-size:20px;cursor:pointer}
.css-desc-DivContentContainer{padding:24px;overflow:auto}
.css-author{display:flex;gap:12px;align-items:center}.css-author img{width:40px;height:40px;border-radius:50%}
[data-e2e=browse-username]{font-weight:700;font-size:18px;display:block}
[data-e2e=browse-video-desc]{margin:16px 0;font-size:16px;line-height:1.4}[data-e2e=browse-video-desc] a{color:#2b5db9;text-decoration:none;font-weight:600}
[data-e2e=browse-music] a{color:#161823;text-decoration:none;font-weight:400;font-size:14px}
.css-actions-DivActionContainer{display:flex;gap:20px;margin-top:24px}
.css-actions-DivActionContainer button{border:0;background:#f1f1f2;border-radius:24px;padding:10px 16px;font-size:15px;display:flex;gap:6px;align-items:center}
`;

function page(title: string, body: string, data: unknown, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<div id="app"><div class="css-hdr-DivHeaderWrapper"><a class="logo" href="/">TikTok</a>
<form class="css-srch-DivSearchFormContainer" action="/search"><input data-e2e="search-user-input" name="q" placeholder="Search" autocomplete="off"></form></div>
${body}</div>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: data }).replace(/</g, "\\u003c")}</script>
<script>${script}</script></body></html>`;
}

/** Accounts that exercise the flow's outcome states. */
export const SPECIAL = { notFound: "nobody", private: "locked", empty: "empty" } as const;
const UNAVAILABLE_SUFFIX = "013"; // video ids ending in this render "Video currently unavailable"

function outcomePage(title: string, heading: string, sub: string) {
  return page(title, `<main class="css-1t4vqp5-DivShareLayoutMain"><div class="css-err-DivErrorContainer" style="text-align:center;padding:80px 0">
<p style="font-size:24px;font-weight:700" class="css-err-PTitle">${esc(heading)}</p><p class="css-err-PDesc">${esc(sub)}</p></div></main>`, {});
}

function profilePage(name: string, chaos?: Chaos) {
  if (name === SPECIAL.notFound) return outcomePage("TikTok", "Couldn't find this account", "Looking for videos? Try browsing our trending creators, hashtags, and sounds.");
  const { user, videos: all } = mockUser(name);
  const videos = name === SPECIAL.empty ? [] : all;
  if (name === SPECIAL.private) return page(`${user.nickname} (@${name}) | TikTok`, `<main class="css-1t4vqp5-DivShareLayoutMain">
<div class="css-1o9t6sm-DivShareInfo" data-e2e="user-page"><div class="css-1kc5ixs-DivShareTitleContainer">
<h1 data-e2e="user-title">${esc(user.nickname)}</h1><h2 data-e2e="user-subtitle">${esc(name)}</h2></div></div>
<div class="css-err-DivErrorContainer"><p class="css-err-PTitle" style="font-weight:700">This account is private</p><p>Follow this account to see their contents and likes</p></div></main>`, {});
  const body = `<main class="css-1t4vqp5-DivShareLayoutMain">
<div class="css-1o9t6sm-DivShareInfo" data-e2e="user-page">
  <div data-e2e="user-avatar"><span class="css-1o7tlns-SpanAvatarContainer"><img src="/img/avatar/${name}.svg" alt="${esc(user.nickname)}" class="css-1zpj2q-ImgAvatar"></span></div>
  <div class="css-1kc5ixs-DivShareTitleContainer">
    <h1 data-e2e="user-title">${esc(user.nickname)}${user.verified ? ' <svg data-e2e="verified" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#20d5ec"/></svg>' : ""}</h1>
    <h2 data-e2e="user-subtitle">${esc(user.uniqueId)}</h2>
    <h3 class="css-12ijjgf-H3CountInfos">
      <div class="css-1ldzp5s-DivNumber"><strong data-e2e="following-count">${abbr(user.stats.followingCount)}</strong><span data-e2e="following">Following</span></div>
      <div class="css-1ldzp5s-DivNumber"><strong data-e2e="followers-count">${abbr(user.stats.followerCount)}</strong><span data-e2e="followers">Followers</span></div>
      <div class="css-1ldzp5s-DivNumber"><strong data-e2e="likes-count">${abbr(user.stats.heart)}</strong><span data-e2e="likes">Likes</span></div>
    </h3>
    <h2 data-e2e="user-bio" class="css-4ac4gk-H2ShareDesc">${esc(user.signature)}</h2>
  </div>
</div>
<div class="css-1qb12g8-DivThreeColumnContainer"><div data-e2e="user-post-item-list" class="css-1qsb9nm-DivVideoFeedV2">
</div>${videos.length ? "" : '<p class="css-err-PTitle" style="text-align:center;font-weight:700">No content</p><p style="text-align:center">This user has not published any videos.</p>'}<div class="loader" id="loader">${videos.length > PER_PAGE ? "Loading…" : ""}</div></div></main>
${chaos?.overlay && chaos.roll() < chaos.p ? `<div data-e2e="modal-mask" style="position:fixed;inset:0;background:#0008;z-index:99;display:none;align-items:center;justify-content:center">
<div style="background:#fff;border-radius:8px;padding:32px;width:420px;text-align:center"><p style="font-weight:700;font-size:20px">Log in to TikTok</p>
<button data-e2e="modal-close-inner-button" aria-label="Close" onclick="this.closest('[data-e2e=modal-mask]').remove()" style="font-size:18px">✕</button></div></div>
<script>setTimeout(()=>{const m=document.querySelector('[data-e2e=modal-mask]');if(m)m.style.display='flex'},700)</script>` : ""}`;
  const script = `
let cursor=0, busy=false, done=${videos.length === 0};
const list=document.querySelector('[data-e2e=user-post-item-list]'), loader=document.getElementById('loader');
async function load(){
  if(busy||done) return; busy=true;
  let r; try { r=await fetch('/api/post/item_list/?user=${encodeURIComponent(name)}&cursor='+cursor).then(r=>{ if(!r.ok) throw new Error(r.status); return r.json(); }); }
  catch(e){ busy=false; return false; } // real feeds retry silently
  await new Promise(r=>setTimeout(r,150));
  list.insertAdjacentHTML('beforeend', r.html);
  cursor=r.cursor; done=!r.hasMore; busy=false;
  if(done) loader.textContent='';
  return true;
}
const io=new IntersectionObserver(async ([e])=>{ if(e.isIntersecting && !(await load())) { io.unobserve(loader); setTimeout(()=>io.observe(loader),400); } },{rootMargin:'200px'});
(async()=>{ for(let i=0;i<8&&cursor===0&&!done;i++){ if(!(await load())) await new Promise(r=>setTimeout(r,400)); } io.observe(loader); })();`;
  return page(`${user.nickname} (@${name}) | TikTok`, body, {
    "webapp.user-detail": { userInfo: { user: { id: user.id, uniqueId: user.uniqueId, nickname: user.nickname, signature: user.signature, verified: user.verified, avatarLarger: `/img/avatar/${name}.svg` }, stats: user.stats } },
  }, script);
}

function videoPage(name: string, id: string) {
  const { user, videos } = mockUser(name);
  const v = videos.find((x) => x.id === id);
  if (!v) return null;
  if (id.endsWith(UNAVAILABLE_SUFFIX)) return outcomePage("TikTok", "Video currently unavailable", "This video may have been removed or made private.");
  const body = `<div class="css-video-DivBrowserModeContainer" data-e2e="browse-video">
<div class="css-video-DivVideoContainer"><button data-e2e="browse-close" aria-label="exit" onclick="history.length>1?history.back():location.href='/@${name}'">✕</button>
  <canvas data-e2e="video-canvas" width="360" height="640"></canvas></div>
<div class="css-desc-DivContentContainer">
  <div class="css-author"><a data-e2e="browse-user-avatar" href="/@${name}"><img src="/img/avatar/${name}.svg" alt=""></a>
    <div><a href="/@${name}" style="color:inherit;text-decoration:none"><span data-e2e="browse-username">${esc(name)}</span></a>
    <span data-e2e="browser-nickname"><span>${esc(user.nickname)}</span><span> · </span><span>${fmtDate(v.createTime)}</span></span></div></div>
  <div data-e2e="browse-video-desc" class="css-1nst91u-DivMainContent"><span class="css-j2a19r-SpanText">${esc(v.desc)} </span>${v.hashtags.map((t) => `<a data-e2e="search-common-link" href="/tag/${t}"><strong>#${t}</strong></a> `).join("")}</div>
  <h4 data-e2e="browse-music" class="css-1e5nc4r-H4Link"><a href="/music/${encodeURIComponent(v.music.title)}-${v.id.slice(-6)}"><div class="css-pvx3oa-DivMusicText">${esc(v.music.title)}</div></a></h4>
  <div class="css-actions-DivActionContainer">
    <button aria-label="like"><span>♥</span><strong data-e2e="like-count">${abbr(v.stats.diggCount)}</strong></button>
    <button aria-label="comment"><span>💬</span><strong data-e2e="comment-count">${abbr(v.stats.commentCount)}</strong></button>
    <button aria-label="favorite"><span>🔖</span><strong data-e2e="undefined-count">${abbr(v.stats.collectCount)}</strong></button>
    <button aria-label="share"><span>↗</span><strong data-e2e="share-count">${abbr(v.stats.shareCount)}</strong></button>
  </div>
</div></div>`;
  // canvas: a "video frame" only visible to pixel/canvas capture, not the DOM
  const script = `
const c=document.querySelector('canvas'),g=c.getContext('2d');let t=0;
(function f(){const gr=g.createLinearGradient(0,0,360,640);gr.addColorStop(0,'hsl(${parseInt(v.id.slice(-3)) % 360},70%,45%)');gr.addColorStop(1,'#111');
g.fillStyle=gr;g.fillRect(0,0,360,640);g.fillStyle='#fff';g.font='bold 28px sans-serif';g.fillText('${v.duration}s clip',24,60);
g.fillRect(24,600,312*((t%${v.duration * 10})/${v.duration * 10}),6);t++;if(t<300)requestAnimationFrame(f)})();`;
  return page(`${esc(v.desc)} | TikTok`, body, {
    "webapp.video-detail": { itemInfo: { itemStruct: { id: v.id, desc: v.desc, createTime: v.createTime, stats: v.stats, music: v.music, author: { uniqueId: name, nickname: user.nickname }, video: { duration: v.duration, cover: v.cover } } } },
  }, script);
}

function svg(id: string, label: string, round = false) {
  const hue = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,30%)"/></linearGradient></defs>
<rect width="300" height="400" ${round ? 'rx="150"' : ""} fill="url(#g)"/><text x="150" y="210" font-family="sans-serif" font-size="${round ? 120 : 28}" fill="#fff" text-anchor="middle">${esc(label)}</text></svg>`;
}

/** Seeded fault injection: transient 503s, slow responses, click-blocking login modal, failing feed API. */
export interface Chaos { p: number; slowMs: number; overlay: boolean; roll: () => number; injected: Record<string, number> }
export function chaosOf(p: number, seed = "chaos"): Chaos {
  return { p, slowMs: 1200, overlay: true, roll: rng(seed), injected: { http503: 0, slow: 0, api500: 0, overlay: 0 } };
}

export function startMock(port = 0, chaos?: Chaos): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (code: number, type: string, body: string) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    const isPage = /^\/@/.test(u.pathname), isApi = u.pathname.startsWith("/api/");
    if (chaos && (isPage || isApi)) {
      if (chaos.roll() < chaos.p) { chaos.injected.slow++; await new Promise((r) => setTimeout(r, chaos.roll() * chaos.slowMs)); }
      if (chaos.roll() < chaos.p) {
        chaos.injected[isApi ? "api500" : "http503"]++;
        return send(isApi ? 500 : 503, "text/html", "<h1>Service Unavailable</h1><p>Please try again later.</p>");
      }
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/@([\w.]+)\/video\/(\d+)\/?$/.exec(u.pathname))) {
      const html = videoPage(m[1], m[2]);
      return html ? send(200, "text/html; charset=utf-8", html) : send(404, "text/plain", "video not found");
    }
    if ((m = /^\/@([\w.]+)\/?$/.exec(u.pathname))) {
      if (m[1] === SPECIAL.notFound) return send(404, "text/html; charset=utf-8", profilePage(m[1]));
      const html = profilePage(m[1], chaos);
      if (chaos && html.includes("modal-mask")) chaos.injected.overlay++;
      return send(200, "text/html; charset=utf-8", html);
    }
    if (u.pathname === "/api/post/item_list/") {
      const name = u.searchParams.get("user") ?? "x";
      const cursor = Number(u.searchParams.get("cursor") ?? 0);
      const { videos } = mockUser(name);
      const slice = videos.slice(cursor, cursor + PER_PAGE);
      const vids = name === SPECIAL.empty ? [] : slice;
      const user = mockUser(name).user;
      return send(200, "application/json", JSON.stringify({
        // tiktok.com-shaped payload (what Apify's actor reads) + pre-rendered tiles for the mock's client
        itemList: vids.map((v) => ({
          id: v.id, desc: `${v.desc} ${v.hashtags.map((t) => "#" + t).join(" ")}`, createTime: v.createTime,
          author: { uniqueId: name, nickname: user.nickname },
          stats: v.stats, music: { title: v.music.title, authorName: v.music.authorName, original: v.music.original },
          video: { duration: v.duration, cover: v.cover }, textExtra: v.hashtags.map((t) => ({ hashtagName: t })),
        })),
        html: vids.map((v) => tile(name, v)).join("\n"), cursor: cursor + vids.length, hasMore: cursor + vids.length < (name === SPECIAL.empty ? 0 : videos.length),
      }));
    }
    if ((m = /^\/img\/cover\/(\d+)\.svg$/.exec(u.pathname))) return send(200, "image/svg+xml", svg(m[1], `#${m[1].slice(-4)}`));
    if ((m = /^\/img\/avatar\/([\w.]+)\.svg$/.exec(u.pathname))) return send(200, "image/svg+xml", svg(m[1], m[1][0].toUpperCase(), true));
    if (u.pathname === "/") return send(200, "text/html", page("TikTok", `<main><p>Try <a href="/@chef.nova">@chef.nova</a></p></main>`, {}));
    send(404, "text/plain", "not found");
  });
  return new Promise((res) => server.listen(port, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    res({ server, url: `http://127.0.0.1:${a.port}` });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ci = process.argv.indexOf("--chaos");
  startMock(Number(process.argv[2] ?? 4545), ci > 0 ? chaosOf(Number(process.argv[ci + 1] ?? 0.2)) : undefined).then(({ url }) => console.log(`tiktok mock on ${url}  (try ${url}/@chef.nova)`));
}
