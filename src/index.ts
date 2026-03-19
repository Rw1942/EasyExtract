import type { Env } from './types';
import { ok, err } from './types';
import { handleTemplates } from './handlers/templates';
import { handleBuckets } from './handlers/buckets';
import { handleUpload } from './handlers/upload';
import { handleExtract, handleGetJob, handleDeleteJob } from './handlers/extract';
import { handleBuildTemplate } from './handlers/buildTemplate';
import { handleSettings } from './handlers/settings';

function checkServices(env: Env) {
  return {
    openai: !!env.OPENAI_API_KEY,
    gcp_sa: !!env.GCP_SA_KEY,
    gcp_project: !!env.GCP_PROJECT_ID,
    db: !!env.DB,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return new Response(null, { status: 404 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      let res: Response;

      // GET /api/health — check which services are configured
      if (path === '/api/health' && request.method === 'GET') {
        const services = checkServices(env);
        const allGood = services.openai && services.gcp_sa && services.gcp_project;
        return corsWrap(ok({ ready: allGood, services }));
      }

      // POST /api/buckets/:id/upload
      const uploadMatch = path.match(/^\/api\/buckets\/([^/]+)\/upload$/);
      if (uploadMatch && request.method === 'POST') {
        res = await handleUpload(request, env, uploadMatch[1], ctx);
        return corsWrap(res);
      }

      // POST /api/jobs/:id/extract
      const extractMatch = path.match(/^\/api\/jobs\/([^/]+)\/extract$/);
      if (extractMatch && request.method === 'POST') {
        res = await handleExtract(request, env, extractMatch[1]);
        return corsWrap(res);
      }

      // GET|DELETE /api/jobs/:id
      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && request.method === 'GET') {
        res = await handleGetJob(env, jobMatch[1]);
        return corsWrap(res);
      }
      if (jobMatch && request.method === 'DELETE') {
        res = await handleDeleteJob(env, jobMatch[1]);
        return corsWrap(res);
      }

      // POST /api/templates/build — must come before the /api/templates catch-all
      if (path === '/api/templates/build' && request.method === 'POST') {
        res = await handleBuildTemplate(request, env);
        return corsWrap(res);
      }

      if (path.startsWith('/api/settings')) {
        res = await handleSettings(request, env);
        return corsWrap(res);
      }

      if (path.startsWith('/api/templates')) {
        res = await handleTemplates(request, env, path);
        return corsWrap(res);
      }

      if (path.startsWith('/api/buckets')) {
        res = await handleBuckets(request, env, path);
        return corsWrap(res);
      }

      return corsWrap(err(404, 'NOT_FOUND', `No route for ${request.method} ${path}`));
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Internal error';
      console.error('Unhandled:', message);
      return corsWrap(err(500, 'INTERNAL_ERROR', message));
    }
  },
} satisfies ExportedHandler<Env>;

function corsWrap(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers });
}
