import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Walk a directory and return every file path relative to it, POSIX-style. */
function listFiles(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory()
      ? listFiles(root, full)
      : [relative(root, full).split(/[\\/]/).join('/')]
  })
}

/** Emit the service worker with a precache list of the real build output.
 *
 *  This runs at closeBundle, once Vite has written the hashed chunks *and*
 *  copied public/, so the list covers everything the app can possibly need —
 *  including the fonts, which are what a naive shell-only precache misses.
 */
function serviceWorker(): Plugin {
  return {
    name: 'meshlight-service-worker',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist')
      // sw.js cannot precache itself, and the rest are for GitHub Pages and
      // for crawlers — the app never fetches any of them, so precaching them
      // would only spend a first-visit download on bytes nobody reads offline.
      const notForTheApp = new Set(['sw.js', 'CNAME', 'robots.txt', 'sitemap.xml', 'og.png'])
      const files = listFiles(outDir)
        .filter((file) => !notForTheApp.has(file))
        .sort()

      // Hash the file list so every build gets its own cache bucket and the
      // previous one is evicted on activate.
      const revision = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12)

      const template = readFileSync(resolve(__dirname, 'src/sw-template.js'), 'utf8')
      const source = template
        .replace('__REVISION__', revision)
        .replace('__PRECACHE__', JSON.stringify(['.', ...files], null, 2))

      writeFileSync(join(outDir, 'sw.js'), source)
      this.info?.(`service worker precaching ${files.length} files (${revision})`)
    },
  }
}

/** Google Analytics, on the deployed site and nowhere else.
 *
 *  Two gates, because "the deployed site" needs both. `apply: 'build'` keeps
 *  the tag out of `npm run dev`, so it is never in the page you develop
 *  against. The hostname check then keeps it out of every build that is not
 *  ours: this is MIT-licensed, and without it a fork or a self-host would
 *  report visitors into an analytics property they do not own and cannot
 *  switch off. */
const ANALYTICS_ID = 'G-MY66HP88S4'
const ANALYTICS_HOSTS = ['meshlight.org', 'www.meshlight.org', 'theanam.github.io']

function analytics(): Plugin {
  return {
    name: 'meshlight-analytics',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head',
          // The standard gtag snippet, with the loader appended from script so
          // that a host outside the list fetches nothing at all — a plain
          // `<script src>` would hit Google before any guard could run.
          children: `
(function () {
  if (${JSON.stringify(ANALYTICS_HOSTS)}.indexOf(location.hostname) === -1) return
  var tag = document.createElement('script')
  tag.async = true
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=${ANALYTICS_ID}'
  document.head.appendChild(tag)
  window.dataLayer = window.dataLayer || []
  function gtag() { dataLayer.push(arguments) }
  window.gtag = gtag
  gtag('js', new Date())
  gtag('config', '${ANALYTICS_ID}')
})()`,
        },
      ]
    },
  }
}

// base is '' so every asset is referenced relatively: the same build serves
// from the custom domain at the root (meshlight.org) and from a GitHub Pages
// project sub-path (user.github.io/meshlight/), with nothing hardcoded.
export default defineConfig({
  base: '',
  plugins: [analytics(), serviceWorker()],
  // strictPort so a port clash fails loudly. Vite's default is to walk up to
  // the next free port, which would quietly hand you 5176 and leave anything
  // pointed at 5175 talking to nothing.
  server: { port: 5175, strictPort: true },
  build: {
    target: 'es2022',
    // Spec §4 hard constraint: nothing may be fetched at runtime, so every
    // dependency (including three) has to end up inside the bundle.
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
})
