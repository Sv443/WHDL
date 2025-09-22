import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { format, styleText } from "node:util";
import cors from "cors";
import "dotenv/config";
import express from "express";
import helmet from "helmet";

//#region >> consts

const { env } = process;

const requiredEnvVars = ["TOKENS", "ALLOWED_DIRS"];
const missingEnvVars = requiredEnvVars.filter(v => !env[v]);

if(missingEnvVars.length > 0) {
  console.error(styleText("red", `Missing required environment variable${missingEnvVars.length === 1 ? "" : "s"}: ${missingEnvVars.join(", ")}`));
  process.exit(1);
}

const port = Number(env.PORT ?? 8034);
const tokens = new Set<string>(env.TOKENS?.split(/[,;]/g).map(t => t.trim()).filter(t => t) ?? []);
const allowedDirs = env.ALLOWED_DIRS?.split(/[,;]/g).map(p => p.trim()).filter(p => p) ?? [dirname(process.execPath)];
const logCreatedFiles = ["true", "1"].includes(env.LOG_CREATED_FILES?.trim().toLowerCase() ?? "");

//#region express app

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.on("error", err => {
  console.error(styleText("red", format(err)));
  process.exit(1);
});

//#region >> routes

app.post("/download", async (req, res) => {
  const { token } = req.query;
  const { url, path } = req.body;

  if(typeof token !== "string" || !tokens.has(token))
    return res.status(404).end();

  if(!url)
    return res.status(400).json({ error: "URL required" });

  if(!path)
    return res.status(400).json({ error: "Path required" });

  if(!allowedDirs.some(ancestorPath => isDescendantPath(path, ancestorPath)))
    return res.status(403).json({ error: "Path not allowed" });

  try {
    const success = () => res.status(200).json({ success: true });
    const to = setTimeout(success, 25_000);

    const resp = await fetch(url);
    const buf = Buffer.from(await (await resp.blob()).arrayBuffer());

    await ensureDirectoryExists(path);
    await writeFile(path, buf);

    if(logCreatedFiles) {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      const kib = Math.round(buf.byteLength / 1024 * 100) / 100;
      const mib = Math.round(buf.byteLength / (1024 * 1024) * 100) / 100;

      console.info(`[${new Date().toISOString()}] [${ip}] Downloaded '${path}' from '${url}' ${mib > 0.5 ? `(${mib} MiB)` : `(${kib} KiB)`}`);
    }

    clearTimeout(to);
    return success();
  }
  catch(err) {
    console.error(styleText("red", format(err)));
    res.status(500).json({ error: `Internal Server Error: ${err}` });
  }
});

app.listen(port, () => console.log(styleText("green", `\nListening on port ${port}\n`)));

//#region >> ensureDirectoryExists

/** Ensures that the directory for `path` exists */
async function ensureDirectoryExists(path: string) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
}

//#region isDescendantPath

/** Returns whether `path` is located anywhere inside `parentPath`'s ancestry */
function isDescendantPath(path: string, parentPath: string) {
  try {
    const resolvedPath = resolve(path);
    const resolvedParentPath = resolve(parentPath);

    const relativePath = relative(resolvedParentPath, resolvedPath);

    if(!relativePath)
      return false;

    return !relativePath.startsWith('..') && !relativePath.startsWith('/') && !relativePath.includes(':');
  }
  catch {
    return false;
  }
}
