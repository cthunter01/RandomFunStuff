# Deploying clang-format Helper

The app is a **fully static site**: HTML, JavaScript, CSS and one WebAssembly module. There is no server-side
code, no database, and nothing to run on the server besides a web server. clang-format executes in each
visitor's browser, so their code never reaches your server either.

This guide covers **nginx** and **Apache**. Ready-to-use configuration lives in [`deploy/`](../deploy):

| File                                               | What it is                                                     |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `deploy/nginx/clang-format-helper.conf`            | nginx `server` block                                           |
| `deploy/nginx/clang-format-helper-headers.conf`    | security headers snippet, included by every location           |
| `deploy/apache/clang-format-helper.conf`           | Apache `<VirtualHost>` (and a commented sub-path variant)      |
| `deploy/apache/clang-format-helper.rules.conf`     | the rules — used from the vhost, *or* as `.htaccess` as-is     |

## The short version

```bash
npm ci
npm run release                      # build + precompress into dist/

# Upload: assets first, the entry point last (see "Uploading" for why).
rsync -a dist/assets/ user@host:/var/www/clang-format-helper/assets/
rsync -a dist/index.html dist/index.html.gz dist/index.html.br user@host:/var/www/clang-format-helper/

# Then install the nginx or Apache config below, and check the result:
npm run check:deploy -- https://clang-format.example.com/
```

## What a server has to get right

Five things. Every other part of the configs is defence in depth.

1. **Serve `.wasm` as `application/wasm`.** Browsers only *stream*-compile WebAssembly with exactly that type.
   Older nginx and Apache packages send `application/octet-stream`. The app still works then, via a slower
   path, and logs a console warning naming the problem.
2. **Cache `assets/` forever and `index.html` never.** Every file under `assets/` has a content hash in its
   name, so a URL there never changes and can be cached for a year with `immutable`. `index.html` is the only
   file that names those hashes, so it must always be revalidated. If it isn't, browsers keep an old copy
   that points at files a later deploy removed.
3. **Compress, including the wasm.** The module is 2.5 MB: ~1 MB gzipped, ~840 KB with brotli. nginx's
   default `gzip_types` does *not* include `application/wasm`, so it has to be listed.
4. **No single-page-app fallback.** The app has no client-side routes. A `try_files … /index.html` fallback
   answers a request for a missing asset with the HTML page and a 200. The browser then fails with a baffling
   "not a valid JavaScript MIME type" error instead of a plain 404.
5. **Nothing else.** In particular, the app does **not** need `Cross-Origin-Opener-Policy` /
   `Cross-Origin-Embedder-Policy`. It uses no threads or `SharedArrayBuffer`. Guides for other WebAssembly
   apps often insist on those headers; adding them here gains nothing and can break embedding.

The app works at the site root or under any sub-path (`https://example.com/tools/clang-format/`) with no
rebuild, because the build uses relative URLs.

## Building

```bash
npm ci
npm run release
```

`release` runs the normal build, then writes a `.gz` and a `.br` next to every compressible file. The web
server serves those directly instead of compressing on each request. That matters here because
maximum-effort brotli takes seconds on the wasm module, far too slow per request and trivial to do once. It
cuts the whole payload from 6.5 MB to 1.7 MB. A plain `npm run build` also deploys fine; the configs fall back
to compressing on the fly (less tightly).

`dist/` also contains **source maps** (`*.map`, about 3 MB). Browsers only fetch them when developer tools are
open, so shipping them costs visitors nothing and makes bug reports readable. If you would rather not publish
them, add `--exclude '*.map*'` to the upload.

## Uploading

```bash
# 1. Assets first. New files appear next to the old ones; nothing references them yet.
rsync -a dist/assets/ user@host:/var/www/clang-format-helper/assets/

# 2. The entry point last. rsync replaces it atomically, which switches visitors over.
rsync -a dist/index.html dist/index.html.gz dist/index.html.br user@host:/var/www/clang-format-helper/
```

The order matters. Upload `index.html` first and anyone who loads the page mid-deploy gets references to
assets that are not there yet. There is deliberately **no `--delete`** on the assets either. A tab opened
before the deploy still holds the old `index.html`, and it can request the old hashed files, so they should
keep existing for a while. Prune them occasionally instead:

```bash
# Remove assets that no deploy in the last 30 days has uploaded.
ssh user@host "find /var/www/clang-format-helper/assets -type f -mtime +30 -delete"
```

This is safe because `rsync -a` refreshes the timestamp of every file each deploy uploads, including ones
whose content did not change. Only files that later builds stopped producing ever age out. Rolling back is
the same two commands run from an older checkout.

## nginx

1. Copy `deploy/nginx/clang-format-helper-headers.conf` to `/etc/nginx/snippets/`. Create the directory if
   your distribution has none; Debian and Ubuntu do, RHEL, Fedora and Arch do not.
2. Copy `deploy/nginx/clang-format-helper.conf` to where your nginx reads sites:
   - Debian / Ubuntu: `/etc/nginx/sites-available/`, then
     `ln -s ../sites-available/clang-format-helper.conf /etc/nginx/sites-enabled/`
   - RHEL / Fedora: `/etc/nginx/conf.d/`
   - Arch: `/etc/nginx/conf.d/`, and add `include conf.d/*.conf;` to the `http` block of `nginx.conf`, which
     Arch does not include by default
3. Edit `server_name` and `root`.
4. `sudo nginx -t && sudo systemctl reload nginx`

Notes:

- **Brotli** needs the third-party `ngx_brotli` module. Debian/Ubuntu package it as
  `libnginx-mod-http-brotli-filter` and `-static`. With it installed, uncomment `brotli_static on;`. Without
  it, nginx serves the precompressed `.gz` files, which is fine.
- **Security headers** live in a snippet because of an nginx trap: a `location` that sets *any* `add_header`
  inherits *none* from the `server` block. Every location here sets `Cache-Control`, so headers declared once
  at server level would quietly vanish from every response. nginx 1.29.3 and later can use
  `add_header_inherit merge;` instead.
- **IPv6.** If nginx refuses to start with `socket() [::]:80 failed (97: Address family not supported by
  protocol)`, the host has IPv6 disabled; delete the `listen [::]:80;` line.
- **Sub-path.** Put the app's files in a sub-directory of an existing site's `root`, e.g.
  `/var/www/html/tools/clang-format/`, and add this file's `location` blocks to that site's `server`. The
  location patterns match on the tail of the URL, so they work unchanged at any depth.

## Apache

Needs `mod_rewrite`, `mod_headers`, `mod_mime` and `mod_env`. `mod_brotli`, `mod_deflate` and `mod_filter`
are optional; they are only used to compress on the fly when the precompressed files are missing.

1. Enable the modules:
   - Debian / Ubuntu: `sudo a2enmod rewrite headers brotli deflate`
   - RHEL / Fedora: normally loaded already; confirm with `httpd -M | grep -E 'rewrite|headers|brotli'`
   - Arch: uncomment their `LoadModule` lines in `/etc/httpd/conf/httpd.conf`
2. Copy `deploy/apache/clang-format-helper.rules.conf` somewhere Apache can read but does **not** load on its
   own: `/etc/apache2/` (Debian/Ubuntu) or `/etc/httpd/conf/` (RHEL, Fedora, Arch). It is meant to be
   included *inside* the vhost's `<Directory>`. Do not put it in `conf.d/` and do not `a2enconf` it. Loaded at
   server level, Apache still starts cleanly, but precompression silently stops working (this was tested),
   and its headers and caching rules then apply to every other site on the server.
3. Copy `deploy/apache/clang-format-helper.conf` into the site configuration:
   - Debian / Ubuntu: `/etc/apache2/sites-available/`, then `sudo a2ensite clang-format-helper`
   - RHEL / Fedora: `/etc/httpd/conf.d/`
   - Arch: `/etc/httpd/conf/extra/`, plus an `Include` line in `httpd.conf`
4. Edit `ServerName`, both paths, and the `Include` path.
5. `sudo apachectl configtest && sudo systemctl reload apache2` (`httpd` on RHEL, Fedora, Arch)

**Sub-path.** Use the commented `Alias` variant at the bottom of `clang-format-helper.conf`. Its
`RewriteBase` line only matters on Apache releases before 2.4.13 (2015). Later ones resolve the `Alias` on
their own, which was confirmed while testing. Older ones would resolve the precompressed-file rewrites against
the filesystem path instead of the URL.

**Shared hosting** (no access to the server config): upload the files into a directory, then upload
`clang-format-helper.rules.conf` into that same directory **renamed to `.htaccess`**. It is written to be
valid there unchanged. The host must allow `AllowOverride FileInfo Indexes Options`, and most allow `All`.

Two Apache details the rules handle, in case you adapt them:

- A precompressed `foo.js.gz` must have `Content-Encoding` set and be **excluded from on-the-fly
  compression**. Otherwise `mod_deflate` compresses it a second time, and browsers fail with a generic decoding
  error that points at nothing. Stock configs also contain `AddType application/x-gzip .gz`, which would
  label it as a gzip download, so the rules force the real type back.
- After the rewrite, the request being answered is `foo.wasm.br`, not `foo.wasm`. A caching rule that matches
  `\.wasm$` therefore silently misses exactly the compressed responses real browsers receive, and every
  visitor re-downloads the module on each visit. That is why the pattern allows a `.br`/`.gz` suffix.

## HTTPS

Use it. With certbot, `sudo certbot --nginx -d clang-format.example.com` or `--apache` edits the configs above
in place. Two app-specific reasons, beyond the usual ones:

- The **Copy** button prefers the Clipboard API, which browsers only expose on HTTPS (or `localhost`). Over
  plain HTTP it falls back to an older copy mechanism, which works but is deprecated.
- A future offline/PWA mode would need a service worker, which is HTTPS-only.

## Content-Security-Policy (optional, recommended)

Both configs carry a commented-out policy. Uncomment it once the site works without it.

```
default-src 'self';
script-src 'self' 'sha256-IBRmPENIcyuBGJYJgtdNtA+MSY2Afterh32qYn1oklE=' 'wasm-unsafe-eval';
style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self';
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'
```

Two parts are specific to this app:

- **`'wasm-unsafe-eval'` is mandatory.** Without it the browser refuses to compile the clang-format module, and
  the page reports *"Could not start clang-format: … blocked by CSP"*.
- **The `sha256-…` hash** allows the small inline script in `index.html` that applies the saved light/dark
  theme before the page first paints. If that script ever changes, recompute the hash after building:

  ```bash
  node -e "const h=require('fs').readFileSync('dist/index.html','utf8');const s=/<script>([\s\S]*?)<\/script>/.exec(h)[1];console.log(\"'sha256-\"+require('crypto').createHash('sha256').update(s).digest('base64')+\"'\")"
  ```

  A stale hash is not fatal. The script is blocked, and the app applies the theme itself a moment later, so
  the only symptom is a brief flash of the other theme on load.

## Checking a deployment

```bash
npm run check:deploy -- https://clang-format.example.com/
npm run check:deploy -- https://example.com/tools/clang-format/    # a sub-path
```

Run it from the checkout you deployed from. It fetches the live files and compares them with your local
`dist/` (pass `--dist <dir>` to compare with another build). It checks each of the points above, and it
verifies compression **byte for byte**: each compressed response is decoded and compared with the original.
That catches double compression, which nothing else will point you at. It exits non-zero on failure, so it
can gate a CI deploy. A correct Apache deployment looks like:

```
ok    wasm module: served as application/wasm
ok    wasm module: cached long-term (Cache-Control: public, max-age=31536000, immutable)
ok    wasm with Accept-Encoding br: br, 840 KB, byte-identical once decoded
ok    wasm with Accept-Encoding br: still cached long-term
ok    wasm with Accept-Encoding gzip: gzip, 1046 KB, byte-identical once decoded
ok    a missing asset is a real 404
...
27 passed, 0 warning(s), 0 failure(s)
```

On nginx without `ngx_brotli`, expect one warning: brotli requests get the uncompressed file.

## Troubleshooting

| Symptom                                                            | Cause and fix                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| "Could not start clang-format: … blocked by CSP"                    | The Content-Security-Policy lacks `'wasm-unsafe-eval'`. Add it to `script-src`.                                            |
| "Could not start clang-format: … failed to download (HTTP 404)"     | The `.wasm` file is missing or the `root` is wrong. Check that `assets/` was uploaded.                                      |
| Console: "not a valid JavaScript MIME type" / module script fails   | A single-page-app fallback is returning `index.html` for a missing file. Remove it; `check:deploy` flags this.              |
| Console warning: module served as "application/octet-stream"        | Old `mime.types` without wasm. The configs force the right type; if you wrote your own, add `application/wasm`.             |
| Page loads, then fails with a content/decoding error                | A precompressed file is compressed a second time on the fly. Use the rules file as-is; `check:deploy` catches this.         |
| Visitors still see the old version after a deploy                   | `index.html` is being cached. It must be served with `Cache-Control: no-cache`.                                            |
| The wasm is re-downloaded on every visit                            | Caching only applies to uncompressed responses (the Apache `.br`/`.gz` rewrite trap above).                                 |
| Security headers on the page, but missing on assets                 | nginx `add_header` inheritance. Include the snippet in every location, as the config does.                                 |
| The theme flashes on load                                           | A CSP whose `sha256-` hash no longer matches the inline script in `index.html`. Recompute it (see above).                   |
| nginx won't start: "Address family not supported by protocol"       | IPv6 is disabled on the host. Remove `listen [::]:80;`.                                                                    |

## How these configs were tested

Not written from memory. nginx **1.30.5** and Apache **2.4.68** (with APR 1.7.6 and APR-util 1.6.5) were
built from source and run against the release build. Verification used `check:deploy` plus the full browser
test (`npm run test:e2e`) in Firefox 154. Scenarios covered:

- nginx at the site root and under a sub-path, with precompressed files and with on-the-fly compression only
- Apache as a virtual host, as `.htaccess` in a sub-directory (shared hosting), and under an `Alias` (with
  and without `RewriteBase`), with precompressed brotli and gzip and with on-the-fly compression only. The
  stock `AddType application/x-gzip .gz` line was left in place, as distribution configs ship it.
- the Content-Security-Policy: no violations with the correct hash. With a stale hash the theme is still
  correct after boot. Without `'wasm-unsafe-eval'` the page shows the error message above.
- the upload procedure: two consecutive builds, old assets still served after the second deploy, and pruning
  removing only files that no longer ship
- plain HTTP on a LAN address, where `navigator.clipboard` is unavailable and Copy uses its fallback

Not tested: TLS termination and certbot (no public DNS here), the `ngx_brotli` module, distribution-packaged
builds of either server, and browsers other than Firefox.
