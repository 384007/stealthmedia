/**
 * StealthMedia — Cloudflare Worker
 *
 * Routes:
 *   POST   /api/upload              — receive file, store to R2, trigger Modal
 *   GET    /api/status/:taskId      — poll task state
 *   DELETE /api/task/:taskId        — user-initiated delete
 *   POST   /internal/callback       — Modal progress callback (token-guarded)
 *   GET    /api/health              — health check
 *
 * Bindings (wrangler.toml):
 *   MEDIA_BUCKET  — R2 bucket
 *   TASK_STATUS   — KV namespace
 *
 * Secrets (wrangler secret put …):
 *   MODAL_API_KEY     Modal.com auth token
 *   MODAL_FUNC_URL    Modal webhook URL for process_media function
 *   WORKER_HOSTNAME   Public hostname of this worker (for callback URL)
 *   R2_ACCOUNT_ID     Cloudflare account ID
 *   R2_ACCESS_KEY     R2 S3-compat access key
 *   R2_SECRET_KEY     R2 S3-compat secret key
 *   R2_BUCKET_NAME    R2 bucket name
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
const MAX_IMAGE_BYTES      = 20  * 1024 * 1024;   // 20 MB
const MAX_VIDEO_BYTES      = 200 * 1024 * 1024;   // 200 MB
const TASK_TTL_SECONDS     = 60 * 60 * 24;        // 24 h KV TTL
const PRESIGNED_TTL_SEC    = 60 * 60;             // 1 h download link

// ─── Entry point ──────────────────────────────────────────────────────────────
export default {
  /** Cron trigger — purge R2 orphans older than 24 h */
  async scheduled(_event, env, _ctx) {
    await purgeExpiredTasks(env);
  },

  /** HTTP handler */
  async fetch(request, env, _ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // ── Health ──────────────────────────────────────────────────────────────
      if (url.pathname === '/api/health') {
        return json({ ok: true }, 200, origin);
      }

      // ── Upload ──────────────────────────────────────────────────────────────
      if (request.method === 'POST' && url.pathname === '/api/upload') {
        return await handleUpload(request, env, origin);
      }

      // ── Status ──────────────────────────────────────────────────────────────
      if (request.method === 'GET' && url.pathname.startsWith('/api/status/')) {
        const taskId = url.pathname.split('/').pop();
        return await handleStatus(taskId, env, origin);
      }

      // ── Delete ──────────────────────────────────────────────────────────────
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/task/')) {
        const taskId = url.pathname.split('/').pop();
        return await handleDelete(taskId, env, origin);
      }

      // ── Internal callback from Modal ────────────────────────────────────────
      if (request.method === 'POST' && url.pathname === '/internal/callback') {
        return await handleCallback(request, env, origin);
      }

      return json({ error: 'Not found' }, 404, origin);
    } catch (err) {
      console.error('Worker unhandled error:', err);
      return json({ error: 'Internal server error' }, 500, origin);
    }
  },
};

// ─── Upload ───────────────────────────────────────────────────────────────────
async function handleUpload(request, env, origin) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: '请求格式错误' }, 400, origin);
  }

  const file = formData.get('file');
  const type = formData.get('type');   // "image" | "video"

  if (!file || !(file instanceof File)) {
    return json({ error: '未收到文件' }, 400, origin);
  }
  if (!['image', 'video'].includes(type)) {
    return json({ error: '无效的文件类型参数' }, 400, origin);
  }

  const mime    = file.type;
  const allowed = type === 'video' ? ALLOWED_VIDEO_TYPES : ALLOWED_IMAGE_TYPES;
  if (!allowed.includes(mime)) {
    return json({ error: '不支持的文件格式' }, 415, origin);
  }

  const maxBytes = type === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > maxBytes) {
    return json({ error: '文件超出大小限制' }, 413, origin);
  }

  // Generate task ID; store file under opaque key (no original filename)
  const taskId   = crypto.randomUUID();
  const ext      = extFromMime(mime);
  const inputKey = `input/${taskId}/source.${ext}`;
  const outputKey = `output/${taskId}/result.${ext}`;

  // Store raw file in R2
  await env.MEDIA_BUCKET.put(inputKey, file.stream(), {
    httpMetadata:   { contentType: mime },
    customMetadata: { taskId, type },
  });

  // Persist initial task state in KV (auto-expires in 24 h)
  const taskData = {
    status:    'queued',
    progress:  0,
    type,
    inputKey,
    outputKey,
    createdAt: Date.now(),
  };
  await env.TASK_STATUS.put(taskId, JSON.stringify(taskData), {
    expirationTtl: TASK_TTL_SECONDS,
  });

  // Fire-and-forget Modal trigger (Worker memory limit: 128 MB;
  // Modal downloads directly from R2 so no re-streaming needed)
  triggerModal(env, taskId, type, inputKey, outputKey).catch((err) => {
    console.error('Modal trigger failed for task', taskId, ':', err);
  });

  return json({ taskId, status: 'queued' }, 202, origin);
}

// ─── Status ───────────────────────────────────────────────────────────────────
async function handleStatus(taskId, env, origin) {
  if (!isValidUUID(taskId)) {
    return json({ error: '无效的 taskId' }, 400, origin);
  }

  const raw = await env.TASK_STATUS.get(taskId);
  if (!raw) {
    return json({ error: '任务不存在或已过期' }, 404, origin);
  }

  const data = JSON.parse(raw);

  if (data.status === 'done' && data.outputKey) {
    const downloadUrl = await generatePresignedUrl(env, data.outputKey);
    return json({
      taskId,
      status:   'done',
      progress: 100,
      downloadUrl,
    }, 200, origin);
  }

  return json({
    taskId,
    status:   data.status,
    progress: data.progress ?? 0,
    ...(data.message ? { message: data.message } : {}),
  }, 200, origin);
}

// ─── Delete ───────────────────────────────────────────────────────────────────
async function handleDelete(taskId, env, origin) {
  if (!isValidUUID(taskId)) {
    return json({ error: '无效的 taskId' }, 400, origin);
  }

  const raw = await env.TASK_STATUS.get(taskId);
  if (!raw) {
    return json({ error: '任务不存在' }, 404, origin);
  }

  const data = JSON.parse(raw);
  await Promise.allSettled([
    data.inputKey  ? env.MEDIA_BUCKET.delete(data.inputKey)  : null,
    data.outputKey ? env.MEDIA_BUCKET.delete(data.outputKey) : null,
  ]);
  await env.TASK_STATUS.delete(taskId);

  return json({ ok: true }, 200, origin);
}

// ─── Internal callback (Modal → Worker) ──────────────────────────────────────
// Modal POSTs here with { taskId, status, progress, message? }
// Protected by the same MODAL_API_KEY Bearer token.
async function handleCallback(request, env, origin) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.MODAL_API_KEY}`) {
    return json({ error: 'Unauthorized' }, 401, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad JSON' }, 400, origin);
  }

  const { taskId, status, progress, message } = body;
  if (!isValidUUID(taskId)) {
    return json({ error: 'Invalid taskId' }, 400, origin);
  }

  const raw = await env.TASK_STATUS.get(taskId);
  if (!raw) return json({ error: 'Task not found' }, 404, origin);

  const data   = JSON.parse(raw);
  const merged = {
    ...data,
    ...(status   !== undefined ? { status }   : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(message  !== undefined ? { message }  : {}),
  };

  await env.TASK_STATUS.put(taskId, JSON.stringify(merged), {
    expirationTtl: TASK_TTL_SECONDS,
  });

  return json({ ok: true }, 200, origin);
}

// ─── Modal trigger ────────────────────────────────────────────────────────────
async function triggerModal(env, taskId, fileType, inputKey, outputKey) {
  const callbackUrl = `https://${env.WORKER_HOSTNAME}/internal/callback`;

  const res = await fetch(env.MODAL_FUNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${env.MODAL_API_KEY}`,
    },
    body: JSON.stringify({
      task_id:      taskId,
      file_type:    fileType,
      input_key:    inputKey,
      output_key:   outputKey,
      callback_url: callbackUrl,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Modal HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ─── R2 Presigned URL (AWS Signature V4) ─────────────────────────────────────
async function generatePresignedUrl(env, key) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKey = env.R2_ACCESS_KEY;
  const secretKey = env.R2_SECRET_KEY;
  const bucket    = env.R2_BUCKET_NAME;
  const region    = 'auto';
  const service   = 's3';
  const host      = `${bucket}.${accountId}.r2.cloudflarestorage.com`;

  const now      = new Date();
  const dateStr  = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dateOnly = dateStr.slice(0, 8);
  const scope    = `${dateOnly}/${region}/${service}/aws4_request`;

  const params = new URLSearchParams({
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    `${accessKey}/${scope}`,
    'X-Amz-Date':          dateStr,
    'X-Amz-Expires':       String(PRESIGNED_TTL_SEC),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonicalRequest = [
    'GET',
    `/${key}`,
    params.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStr,
    scope,
    await sha256hex(canonicalRequest),
  ].join('\n');

  const sigKey   = await deriveSigningKey(secretKey, dateOnly, region, service);
  const signature = await hmacHex(sigKey, stringToSign);
  params.set('X-Amz-Signature', signature);

  return `https://${host}/${key}?${params.toString()}`;
}

// ─── Cron: purge expired R2 objects ──────────────────────────────────────────
async function purgeExpiredTasks(env) {
  const cutoff = Date.now() - TASK_TTL_SECONDS * 1000;
  for (const prefix of ['input/', 'output/']) {
    let cursor;
    do {
      const list = await env.MEDIA_BUCKET.list({ prefix, cursor, limit: 200 });
      await Promise.allSettled(
        list.objects
          .filter((o) => o.uploaded && new Date(o.uploaded).getTime() < cutoff)
          .map((o)  => env.MEDIA_BUCKET.delete(o.key))
      );
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
}

// ─── Crypto helpers (Web Crypto — available in Workers runtime) ───────────────
async function sha256hex(message) {
  const buf = await crypto.subtle.digest('SHA-256', enc(message));
  return hex(buf);
}

async function hmacHex(keyBytes, message) {
  const key = await importHmac(keyBytes);
  const sig = await crypto.subtle.sign('HMAC', key, enc(message));
  return hex(sig);
}

async function hmacBytes(keyBytes, message) {
  const key = await importHmac(keyBytes);
  const sig = await crypto.subtle.sign('HMAC', key, enc(message));
  return new Uint8Array(sig);
}

function importHmac(keyBytes) {
  return crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

async function deriveSigningKey(secret, date, region, service) {
  let k = enc('AWS4' + secret);
  k = await hmacBytes(k, date);
  k = await hmacBytes(k, region);
  k = await hmacBytes(k, service);
  k = await hmacBytes(k, 'aws4_request');
  return k;
}

const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// ─── Misc utils ───────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ['https://stealthmedia.pages.dev'];
  const o = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  o,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function extFromMime(mime) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
           'video/mp4': 'mp4', 'video/quicktime': 'mov' }[mime] || 'bin';
}

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}
