export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      return Response.json({
        ok: true,
        service: 'PDFora',
        frontend: 'html-css-javascript',
        processing: 'private-browser',
        storage: 'none',
        backend: 'cloudflare-worker'
      }, {
        headers: {
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex'
        }
      });
    }

    if (url.pathname === '/api/config') {
      return Response.json({
        ok: true,
        siteUrl: new URL(request.url).origin,
        supportEmail: 'hikmatmarwat1100@gmail.com',
        processing: 'browser'
      }, {
        headers: {
          'Cache-Control': 'public, max-age=300',
          'X-Robots-Tag': 'noindex'
        }
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({
        ok: false,
        error: 'PDF processing runs privately in your browser. No file upload API is required.'
      }, {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex'
        }
      });
    }

    // Safe fallback if the route configuration is ignored or removed.
    return env.ASSETS.fetch(request);
  }
};
