import { copyFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const outputDirectory = join(projectRoot, 'dist', 'docs-assets')

await mkdir(outputDirectory, { recursive: true })

const assets = [
  {
    source: require.resolve('@stoplight/elements/web-components.min.js'),
    destination: 'stoplight-elements.js',
  },
  {
    source: require.resolve('@stoplight/elements/styles.min.css'),
    destination: 'stoplight-elements.css',
  },
]

for (const asset of assets) {
  await copyFile(asset.source, join(outputDirectory, asset.destination))
}

console.log(`Copied ${assets.length} Stoplight assets to dist/docs-assets`)
