/** HTML shell for the interactive Stoplight Elements API reference. */
export function renderDocsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Webhook Delivery Service API</title>
    <link
      rel="stylesheet"
      href="/docs/assets/stoplight-elements.css"
    />
    <script
      src="/docs/assets/stoplight-elements.js"
      defer
    ></script>
    <style>
      html,
      body {
        height: 100%;
        margin: 0;
      }

      elements-api {
        display: block;
        height: 100vh;
      }
    </style>
  </head>
  <body>
    <elements-api
      apiDescriptionUrl="/openapi.json"
      router="hash"
      layout="sidebar"
    ></elements-api>
    <noscript>This API reference requires JavaScript.</noscript>
  </body>
</html>`
}
