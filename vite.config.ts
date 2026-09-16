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
      const files = listFiles(outDir)
        .filter((file) => file !== 'sw.js')
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

// base is '' so the build works from any GitHub Pages sub-path
// (user.github.io/meshlight/) without hardcoding the repo name.
export default defineConfig({
  base: '',
  plugins: [serviceWorker()],
  build: {
    target: 'es2022',
    // Spec §4 hard constraint: nothing may be fetched at runtime, so every
    // dependency (including three) has to end up inside the bundle.
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
})
