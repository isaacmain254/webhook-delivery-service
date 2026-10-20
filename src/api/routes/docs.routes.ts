import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Router } from 'express'
import { renderDocsPage } from '../../docs/docs-page.js'
import { getOpenApiDocument } from '../../docs/openapi.js'

const require = createRequire(import.meta.url)
const docsAssetDirectory = join(process.cwd(), 'dist', 'docs-assets')

function resolveDocsAsset(fileName: string, packageExport: string): string {
  const builtAsset = join(docsAssetDirectory, fileName)
  if (existsSync(builtAsset)) {
    return builtAsset
  }

  // Development and tests can use the package directly before a build.
  return require.resolve(packageExport)
}

const stoplightElementsScript = resolveDocsAsset(
  'stoplight-elements.js',
  '@stoplight/elements/web-components.min.js',
)
const stoplightElementsStyles = resolveDocsAsset(
  'stoplight-elements.css',
  '@stoplight/elements/styles.min.css',
)

const docsRouter = Router()

// Assets are served from the pinned npm package so the docs work without a CDN.
docsRouter.get('/docs/assets/stoplight-elements.js', (_req, res) => {
  res.sendFile(stoplightElementsScript, { maxAge: '1d' })
})

docsRouter.get('/docs/assets/stoplight-elements.css', (_req, res) => {
  res.sendFile(stoplightElementsStyles, { maxAge: '1d' })
})

docsRouter.get(['/docs', '/docs/'], (_req, res) => {
  res.type('html').send(renderDocsPage())
})

docsRouter.get('/openapi.json', (_req, res) => {
  res.json(getOpenApiDocument())
})

export default docsRouter
