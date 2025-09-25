import { exec } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, basename, relative, resolve } from "node:path";
import { format, styleText } from "node:util";
import { createServer as createHTTPServer } from "http";
import { createServer as createHTTPSServer } from "https";
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
  exit(1);
}

const splitRegex = /[;]/g;
const filterStr = (s: string) => s.length > 0;

const port = Number(env.PORT ?? 8034);
const tokens = new Set<string>(env.TOKENS?.split(splitRegex).map(t => t.trim()).filter(filterStr) ?? []);
const allowedDirs = env.ALLOWED_DIRS?.split(splitRegex).map(p => p.trim()).filter(filterStr) ?? [dirname(process.execPath)];
const allowedFilePatterns = env.ALLOWED_FILE_PATTERNS?.split(splitRegex).map(p => p.trim()).filter(filterStr) ?? [];
const logRequests = ["true", "1"].includes(env.LOG_REQUESTS?.trim().toLowerCase() ?? "");
const certPath = env.HTTPS_CERTIFICATE_PATH?.trim();
const privkeyPath = env.HTTPS_PRIVATE_KEY_PATH?.trim();

const useHTTPS = typeof certPath === "string" && certPath.length > 0 && typeof privkeyPath === "string" && privkeyPath.length > 0;

if(tokens.size === 0) {
  console.error(styleText("red", "No valid tokens found in 'TOKENS'"));
  exit(1);
}

if(allowedDirs.length === 0) {
  console.error(styleText("red", "No valid directories found in 'ALLOWED_DIRS'"));
  exit(1);
}

if(allowedFilePatterns.length === 0) {
  console.error(styleText("red", "No valid file patterns found in 'ALLOWED_FILE_PATTERNS'"));
  exit(1);
}

//#region express app

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.on("error", err => criticalError(err));

let key: string | undefined, cert: string | undefined;

if(useHTTPS) {
  try {
    key = String(await readFile(privkeyPath!));
    cert = String(await readFile(certPath!));
  }
  catch(err) {
    console.error(styleText("red", `Failed to read HTTPS key or certificate:\n`) + err);
    exit(1);
  }
}

const server = useHTTPS
  ? createHTTPSServer({ key, cert }, app)
  : createHTTPServer(app);

server.on("error", err => criticalError(err));

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

server.listen(port, () => console.log(styleText("green", `\nListening on port ${port}\n`)));

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
