import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { fileBytes } from '../src/shared/files.ts';

export const browserDownloadPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj\n4 0 obj<</Length 0>>stream\n\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

export async function createBrowserDownloadFixture() {
  const cookie = randomUUID();
  let authenticated = 0;
  let unauthenticated = 0;
  let slowStarted!: () => void;
  const slowDownloadStarted = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  let crossOrigin = '';
  const handle: RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/session') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': `synthetic-session=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
      });
      response.end(`<html><title>Synthetic invoices</title><style>body > * { display: block; margin: 8px 0; }</style><body>
        <a id="download" href="/invoice.pdf" download="invoice.pdf">Download invoice</a>
        <button id="popup" onclick="window.open('/invoice.pdf','_blank')">Invoice popup</button>
        <button id="blob" onclick="fetch('/invoice.pdf').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=window.URL.createObjectURL(b);a.download='invoice.pdf';document.body.append(a);a.click()})">Invoice blob</button>
        <a id="blob-anchor" href="#" onclick="event.preventDefault();fetch('/invoice.pdf').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=window.URL.createObjectURL(b);a.download='invoice.pdf';document.body.append(a);a.click()})">Generate invoice</a>
        <a id="cross-origin" href="${crossOrigin}/invoice.pdf">Download hosted invoice</a>
        <button id="large" onclick="window.location='/large.pdf'">Download large invoice</button>
        <button id="slow" onclick="window.location='/slow.pdf'">Download slow invoice</button>
        </body></html>`);
    } else if (url.pathname === '/redirect.pdf') {
      response.writeHead(302, { location: `${crossOrigin}/invoice.pdf` });
      response.end();
    } else if (['/invoice.pdf', '/inline.pdf', '/large.pdf', '/slow.pdf'].includes(url.pathname)) {
      if (request.headers.cookie !== `synthetic-session=${cookie}`) {
        unauthenticated++;
        response.writeHead(403);
        response.end('Authentication required');
        return;
      }
      authenticated++;
      if (url.pathname === '/slow.pdf') {
        response.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': 8 * 1024 * 1024,
          'content-disposition': 'attachment; filename="slow.pdf"',
          'cache-control': 'no-store',
        });
        response.write(Buffer.alloc(256 * 1024));
        slowStarted();
        let remaining = 31;
        const timer = setInterval(() => {
          response.write(Buffer.alloc(256 * 1024));
          if (--remaining === 0) response.end();
        }, 100);
        response.once('close', () => clearInterval(timer));
        return;
      }
      const bytes =
        url.pathname === '/large.pdf'
          ? Buffer.alloc(fileBytes + 1, 32)
          : url.searchParams.get('version') === 'current'
            ? Buffer.concat([browserDownloadPdf, Buffer.from('% current document\n')])
            : browserDownloadPdf;
      response.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': bytes.length,
        'content-disposition': `${url.pathname === '/inline.pdf' ? 'inline' : 'attachment'}; filename="invoice.pdf"`,
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  };
  const server = createServer(handle);
  const documents = createServer(handle);
  await new Promise<void>((resolve) => documents.listen(0, '127.0.0.1', resolve));
  const documentsAddress = documents.address();
  if (!documentsAddress || typeof documentsAddress === 'string')
    throw new Error('Fixture could not start.');
  crossOrigin = `http://127.0.0.1:${documentsAddress.port}`;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture could not start.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    crossOrigin,
    slowDownloadStarted: () => slowDownloadStarted,
    authenticatedDownloads: () => authenticated,
    unauthenticatedDownloads: () => unauthenticated,
    close: async () => {
      await Promise.all(
        [server, documents].map(async (value) => {
          value.closeAllConnections();
          await new Promise<void>((resolve) => value.close(() => resolve()));
        }),
      );
    },
  };
}
