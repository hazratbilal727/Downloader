"use strict";
// Downloader service: implements the API used by index.html and serves it.
// Needs Node 18+, yt-dlp and ffmpeg on PATH. Run: node server.js  ->  http://localhost:3000
// Only download media you own, have permission to save, or that is offered for download.
// Optional: ALLOWED_HOSTS="example.com,videos.example.org" restricts which sites are accepted.
const http = require("http"),
  fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = +process.env.PORT || 3000,
  HOST = process.env.HOST || "127.0.0.1";
const DIR = path.join(__dirname, "downloads");
fs.mkdirSync(DIR, { recursive: true });
const ALLOWED = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const jobs = new Map();

const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const fail = (res, code, errCode, message) =>
  send(res, code, { code: errCode, message });
const readJson = (req) =>
  new Promise((ok, no) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1e5) req.destroy();
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(b || "{}"));
      } catch (e) {
        no(e);
      }
    });
  });

function checkUrl(u) {
  let x;
  try {
    x = new URL(u);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(x.protocol)) return null;
  if (
    ALLOWED.length &&
    !ALLOWED.some((h) => x.hostname === h || x.hostname.endsWith("." + h))
  )
    return null;
  return x.href;
}
function runYtdlp(args, timeout = 40000) {
  return new Promise((ok, no) => {
    const p = spawn("yt-dlp", args);
    let out = "",
      err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => {
      clearTimeout(t);
      no({ missing: true });
    });
    p.on("close", (c) => {
      clearTimeout(t);
      c === 0 ? ok(out) : no({ err });
    });
  });
}
function commandAvailable(command, versionArg) {
  return new Promise((resolve) => {
    const p = spawn(command, [versionArg], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      p.kill();
      resolve(false);
    }, 5000);
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
function ytError(res, e) {
  if (e.missing)
    return fail(
      res,
      503,
      "backend",
      "yt-dlp is missing. Install yt-dlp and ffmpeg on the server, then restart it.",
    );
  if (/unsupported url/i.test(e.err || ""))
    return fail(
      res,
      422,
      "unsupported",
      "This platform is currently not supported.",
    );
  return fail(
    res,
    422,
    "unavailable",
    "The requested media could not be retrieved.",
  );
}

async function analyze(req, res) {
  const url = checkUrl((await readJson(req)).url);
  if (!url)
    return fail(
      res,
      400,
      "unsupported",
      "This platform is currently not supported.",
    );
  let info;
  try {
    info = JSON.parse(
      await runYtdlp(["-J", "--no-playlist", "--no-warnings", "--", url]),
    );
  } catch (e) {
    return ytError(res, e);
  }
  const fmts = info.formats || [],
    size = (f) => f.filesize || f.filesize_approx || 0;
  const vids = fmts.filter((f) => f.vcodec && f.vcodec !== "none" && f.height),
    auds = fmts.filter(
      (f) =>
        f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"),
    );
  const bestAudio = Math.max(0, ...auds.map(size));
  const heights = [...new Set(vids.map((f) => f.height))].sort((a, b) => a - b);
  const formats = heights.map((h) => {
    const s =
      Math.max(...vids.filter((f) => f.height === h).map(size)) + bestAudio;
    return {
      id: "v" + h,
      kind: "video",
      resolution: h + "p",
      container: "mp4",
      size: s || null,
    };
  });
  if (auds.length || vids.length)
    formats.push(
      { id: "m4a", kind: "audio", container: "m4a", size: bestAudio || null },
      { id: "mp3", kind: "audio", container: "mp3", bitrate: 192, size: null },
    );
  send(res, 200, {
    platform: info.extractor_key || "",
    title: info.title || "Untitled",
    channel: info.uploader || info.channel || "",
    duration: info.duration || null,
    thumbnail: info.thumbnail || "",
    views: info.view_count ?? null,
    description: (info.description || "").slice(0, 400),
    formats,
  });
}

function start(req, res, body) {
  const url = checkUrl(body.url),
    fid = String(body.formatId || "");
  if (!url)
    return fail(
      res,
      400,
      "unsupported",
      "This platform is currently not supported.",
    );
  if (!/^(v\d{3,4}|mp3|m4a)$/.test(fid))
    return fail(res, 400, "unavailable", "Unknown format.");
  const id = crypto.randomBytes(8).toString("hex");
  const sel =
    fid[0] === "v"
      ? [
          "-f",
          `bv*[height<=${fid.slice(1)}]+ba/b[height<=${fid.slice(1)}]`,
          "--merge-output-format",
          "mp4",
        ]
      : fid === "mp3"
        ? ["-x", "--audio-format", "mp3", "--audio-quality", "192K"]
        : ["-x", "--audio-format", "m4a"];
  const args = [
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "--restrict-filenames",
    "--progress-template",
    "download:dl:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
    ...sel,
    "-o",
    path.join(DIR, id + "_%(title).80B.%(ext)s"),
    "--",
    url,
  ];
  const job = {
    id,
    status: "preparing",
    downloaded: null,
    total: null,
    speed: null,
    eta: null,
    filename: null,
    fileUrl: null,
    error: null,
    pausable: process.platform !== "win32",
    proc: null,
  };
  const p = spawn("yt-dlp", args);
  job.proc = p;
  jobs.set(id, job);
  const n = (v) => (v && v !== "NA" && !isNaN(+v) ? +v : null);
  let buf = "",
    errTxt = "";
  p.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) {
      if (l.startsWith("dl:")) {
        const [dl, tot, est, sp, eta] = l.slice(3).split("|");
        if (job.status !== "paused") job.status = "downloading";
        job.downloaded = n(dl);
        job.total = n(tot) || n(est);
        job.speed = n(sp);
        job.eta = n(eta);
      } else if (/^\[(Merger|ExtractAudio|VideoConvertor|Fixup)/.test(l))
        job.status = "processing";
      else if (
        l.startsWith("[download] Destination") ||
        l.startsWith("[info]")
      ) {
        if (job.status === "preparing") job.status = "fetching";
      }
    }
  });
  p.stderr.on("data", (d) => (errTxt += d));
  p.on("error", () => {
    job.status = "failed";
    job.error = "yt-dlp is not installed on the server.";
  });
  p.on("close", (code) => {
    if (job.status === "cancelled") return;
    const f = fs
      .readdirSync(DIR)
      .filter(
        (x) => x.startsWith(id + "_") && !/\.(part|ytdl)$|\.f\d+\./.test(x),
      )
      .sort(
        (a, b) =>
          fs.statSync(path.join(DIR, b)).size -
          fs.statSync(path.join(DIR, a)).size,
      )[0];
    if (code === 0 && f) {
      job.status = "completed";
      job.filename = f.slice(id.length + 1);
      job.fileUrl = "/files/" + encodeURIComponent(f);
      job.total = fs.statSync(path.join(DIR, f)).size;
      job.downloaded = job.total;
      job.speed = job.eta = null;
    } else if (job.status !== "failed") {
      job.status = "failed";
      job.error = "The download could not be completed. Retry the download.";
    }
  });
  send(res, 200, { id });
}
const view = (j) => ({
  id: j.id,
  status: j.status,
  downloaded: j.downloaded,
  total: j.total,
  speed: j.speed,
  eta: j.eta,
  filename: j.filename,
  fileUrl: j.fileUrl,
  error: j.error,
  capabilities: { pause: j.pausable, resume: j.pausable },
});
function control(job, action, res) {
  const live = [
    "preparing",
    "fetching",
    "downloading",
    "paused",
    "processing",
  ].includes(job.status);
  if (!live)
    return fail(res, 409, "unavailable", "This download is not active.");
  if (action === "cancel") {
    job.status = "cancelled";
    job.proc.kill("SIGTERM");
  } else if (!job.pausable)
    return fail(
      res,
      400,
      "unavailable",
      "Pause is not supported on this server.",
    );
  else if (action === "pause" && job.status === "downloading") {
    job.proc.kill("SIGSTOP");
    job.status = "paused";
    job.speed = null;
  } else if (action === "resume" && job.status === "paused") {
    job.proc.kill("SIGCONT");
    job.status = "downloading";
  }
  send(res, 200, view(job));
}

http
  .createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x"),
        p = u.pathname;
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return fs
          .createReadStream(path.join(__dirname, "index.html"))
          .pipe(res);
      }
      if (req.method === "GET" && p === "/api/health") {
        const [ytDlp, ffmpeg] = await Promise.all([
          commandAvailable("yt-dlp", "--version"),
          commandAvailable("ffmpeg", "-version"),
        ]);
        return send(res, 200, {
          ready: ytDlp,
          dependencies: { ytDlp, ffmpeg },
        });
      }
      if (req.method === "GET" && p.startsWith("/files/")) {
        const name = path.basename(decodeURIComponent(p.slice(7))),
          file = path.join(DIR, name);
        if (!fs.existsSync(file))
          return fail(res, 404, "unavailable", "File not found.");
        const clean = name.replace(/^[0-9a-f]{16}_/, "");
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": fs.statSync(file).size,
          "Content-Disposition": `attachment; filename="${clean.replace(/"/g, "")}"`,
          "X-Content-Type-Options": "nosniff",
        });
        if (u.searchParams.get("removeAfterDownload") === "1")
          res.once("finish", () => fs.unlink(file, () => {}));
        return fs.createReadStream(file).pipe(res);
      }
      if (p === "/api/analyze" && req.method === "POST")
        return await analyze(req, res);
      if (p === "/api/download" && req.method === "POST")
        return start(req, res, await readJson(req));
      if (p === "/api/downloads" && req.method === "GET")
        return send(res, 200, [...jobs.values()].map(view));
      const m = p.match(
        /^\/api\/download\/([0-9a-f]{16})(?:\/(pause|resume|cancel))?$/,
      );
      if (m) {
        const job = jobs.get(m[1]);
        if (!job) return fail(res, 404, "unavailable", "Unknown download.");
        if (!m[2] && req.method === "GET") return send(res, 200, view(job));
        if (m[2] && req.method === "POST") return control(job, m[2], res);
      }
      fail(res, 404, "backend", "Not found.");
    } catch (e) {
      fail(res, 500, "backend", "Server error.");
    }
  })
  .listen(PORT, HOST, () =>
    console.log(
      `Downloader running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
    ),
  );
