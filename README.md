<div style="text-align: center;" align="center">

# WHDL
Self-hosted, webhook-based, token-authenticated file downloader and RPC service.  
Supports downloading and deleting files as well as calling bash or batch scripts.

</div>

<br><br>

## Setup
1. Clone the repository or download and extract the ZIP (green button at the top).
2. Install [Node.js](https://nodejs.org/) (LTS version recommended) and [npm.](https://npmjs.com/)
3. Call the command `npm i` in a terminal inside the downloaded folder to install the dependencies.
4. Copy `.env.example` to `.env` and fill out the contained environment variables as needed.
5. Call the command `npm start` to start the service.  
  Use something like [pm2](https://pm2.keymetrics.io/), [systemd](https://wiki.archlinux.org/title/systemd) or [Windows Task Scheduler](https://docs.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-start-page) to start it automatically at system startup.
  
- ⚠️ Should one of the tokens be exfiltrated, an attacker could download and execute any script with the privileges of the user that started the service. You should limit access as much as possible in `.env` and always exercise caution with that file.

<br><br>

## Usage
### To download files:
Send a POST request to `http://<host>:<port>/download?token=<token>` with a JSON body like this:
```json
{
  "url": "https://example.com/file.zip",
  "path": "/absolute/path/to/save/file.zip"
}
```
```json
{
  "url": "https://example.com/",
  "path": "C:\\Users\\user\\Downloads\\example.com.html"
}
```

- The specified `path` must be a subdirectory of one of the allowed directories specified in the semicolon-separated `ALLOWED_DIRS` environment variable (in `.env`).
- Use [GLOB patterns](https://www.malikbrowne.com/blog/a-beginners-guide-glob-patterns/) in `ALLOWED_FILE_PATTERNS` (in `.env`) to restrict which files can be modified.
- Tokens are specified in the semicolon-separated `TOKENS` environment variable (in `.env`).
- If the directory does not exist, it will be created automatically.
- Should the download take longer than 25 seconds, the request will succeed preemptively, while the download still continues in the background.

<br><br>

## To delete files:
Send a DELETE request to `http://<host>:<port>/delete?token=<token>` with a JSON body like this:
```json
{
  "path": "/absolute/path/to/delete/file.zip"
}
```
```json
{
  "path": "C:\\Users\\user\\Documents\\file.zip"
}
```
Using a glob pattern:
```json
{
  "path": "C:\\Users\\user\\Documents\\",
  "pattern": "*.{zip,rar,tar,tar.gz}"
}
```

- If the no matching file is found, the request will still succeed.

<br><br>

### To execute scripts:
Send a POST request to `http://<host>:<port>/run?token=<token>` with a JSON body like this:
```json
{
  "path": "/absolute/path/to/script.sh"
}
```
```json
{
  "path": "C:\\Users\\user\\Documents\\unzip_file.bat"
}
```

- This feature is disabled by default, because script file extensions are not included in `.env.template`'s `ALLOWED_FILE_PATTERNS`.
- Only files ending in `.bat`, `.cmd` and `.sh` will be callable, even if other extensions are added to `ALLOWED_FILE_PATTERNS`.

<br><br>

<div style="text-align: center;" align="center">

Copyright © 2025 Sv443 - Licensed under the [MIT License](./LICENSE.txt)  
If you like my projects, please consider [supporting the development ❤️](https://github.com/sponsors/Sv443)

</div>
