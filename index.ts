import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, basename, relative, resolve, join } from "node:path";
import { format, styleText } from "node:util";
import cors from "cors";
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import isGlob from "is-glob";
import picomatch from "picomatch";
import { readdirGlob } from "readdir-glob";

//#region >> consts

const { env, exit } = process;

function criticalError(err: unknown) {
  console.error(styleText("red", format(err)));
  exit(1);
}

const requiredEnvVars = ["TOKENS", "ALLOWED_DIRS", "ALLOWED_FILE_PATTERNS"];
const missingEnvVars = requiredEnvVars.filter(v => !env[v]);

if(missingEnvVars.length > 0) {
  console.error(styleText("red", `Missing required environment variable${missingEnvVars.length === 1 ? "" : "s"}: ${missingEnvVars.join(", ")}`));
  process.exit(1);
}

const splitRegex = /[;]/g;

const port = Number(env.PORT ?? 8034);
const tokens = new Set<string>(env.TOKENS?.split(splitRegex).map(t => t.trim()).filter(t => t) ?? []);
const allowedDirs = env.ALLOWED_DIRS?.split(splitRegex).map(p => p.trim()).filter(p => p) ?? [dirname(process.execPath)];
const allowedFilePatterns = env.ALLOWED_FILE_PATTERNS?.split(splitRegex).map(p => p.trim()).filter(p => p) ?? [];
const logRequests = ["true", "1"].includes(env.LOG_REQUESTS?.trim().toLowerCase() ?? "");

//#region express app

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.on("error", err => criticalError(err));

//#region >> download

// downloads a file from a URL
app.post("/download", async (req, res) => {
  const { url } = req.body;

  if(!verifyRequest(req, res))
    return;

  if(typeof url !== "string")
    return res.status(400).json({ error: "URL required" });

  const path = await getPath(req, res);

  if(!path)
    return;

  try {
    const success = () => res.status(201).json({ success: true });
    const to = setTimeout(success, 25_000);

    const resp = await fetch(url);
    const buf = Buffer.from(await (await resp.blob()).arrayBuffer());

    await ensureDirectoryExists(path);
    await writeFile(path, buf);

    if(logRequests) {
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

//#region run

// runs a shell or batch script
app.post("/run", async (req, res) => {
  if(!verifyRequest(req, res))
    return;

  const path = await getPath(req, res);

  if(!path)
    return;

  if(![".bat", ".cmd", ".sh"].some(ext => path.toLowerCase().endsWith(ext)))
    return res.status(400).json({ error: "Wrong file type" });

  try {
    exec(`"${path}"`, (error, stdout, stderr) => {
      if(error) {
        console.error(styleText("red", format(error)));
        return res.status(500).json({ error: `Internal Server Error: ${error?.message}` });
      }

      if(logRequests) {
        const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
        console.info(`[${new Date().toISOString()}] [${ip}] Ran '${path}'`);
      }

      return res.status(200).json({ success: true, stdout, stderr });
    });
  }
  catch(err) {
    console.error(styleText("red", format(err)));
    res.status(500).json({ error: `Internal Server Error: ${err}` });
  }
});

//#region delete

// deletes one or multiple files
app.delete("/delete", async (req, res) => {
  if(!verifyRequest(req, res))
    return;

  const path = await getPath(req, res);

  if(!path)
    return;

  const success = () => {
    if(logRequests) {
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      console.info(`[${new Date().toISOString()}] [${ip}] Deleted '${path}'`);
    }
    res.status(200).json({ success: true });
  }

  const pattern = req.body?.pattern;

  try {
    if(typeof pattern === "string" && isGlob(pattern, { strict: false })) {
      readdirGlob(path, { pattern, absolute: true }, async (err, matches) => {
        if(err) {
          console.error(styleText("red", format(err)));
          return res.status(500).json({ error: `Internal Server Error: ${err}` });
        }

        if(!matches || matches.length === 0)
          return success();

        await Promise.all(matches.map(async p => rm(p)));

        return success();
      });
    }
    else {
      await rm(path);
      return success();
    }
  }
  catch(err) {
    if((err as { code?: string })?.code === "ENOENT")
      return success();

    console.error(styleText("red", format(err)));
    res.status(500).json({ error: `Internal Server Error: ${err}` });
  }
});

//#region >> listen

const server = app.listen(port, () => console.log(styleText("green", `\nListening on port ${port}\n`)));

server.on("error", err => criticalError(err));

//#region >> verifyRequest

/** Verifies that the request is valid */
function verifyRequest(req: express.Request, res: express.Response) {
  const { token } = req.query;

  if(typeof token !== "string" || !tokens.has(token)) {
    res.status(404).end();
    return false;
  }

  return true;
}

//#region getPathFromRequest

/** Extracts the path from the request body */
async function getPath(req: express.Request, res: express.Response) {
  const { path } = req.body;

  if(typeof path !== "string") {
    res.status(400).json({ error: "Path required" });
    return null;
  }

  if(!picomatch.isMatch(basename(path), allowedFilePatterns) && basename(path).includes(".")) {
    res.status(403).json({ error: "File pattern not allowed" });
    return null;
  }

  if(!allowedDirs.some(ancestorPath => isDescendantPath(path, ancestorPath))) {
    res.status(403).json({ error: "Path not allowed" });
    return null;
  }

  return path as string;
}

//#region ensureDirectoryExists

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

    if(resolvedPath === resolvedParentPath)
      return true;

    const relativePath = relative(resolvedParentPath, resolvedPath);

    if(!relativePath)
      return false;

    return !relativePath.startsWith('..') && !relativePath.startsWith('/') && !relativePath.includes(':');
  }
  catch {
    return false;
  }
}
