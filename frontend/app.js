/**
 * StealthMedia — Frontend App
 * Communicates with Cloudflare Worker API
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const API_BASE = '/api';          // Worker is same-origin via Pages proxy
const POLL_INTERVAL_MS = 2000;    // Poll every 2 seconds
const MAX_IMAGE_BYTES  = 20  * 1024 * 1024;   // 20 MB
const MAX_VIDEO_BYTES  = 200 * 1024 * 1024;   // 200 MB

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const uploadZone   = document.getElementById('uploadZone');
const fileInput    = document.getElementById('fileInput');
const fileInfo     = document.getElementById('fileInfo');
const fileTypeIcon = document.getElementById('fileTypeIcon');
const fileNameEl   = document.getElementById('fileName');
const fileSizeEl   = document.getElementById('fileSize');
const fileRemove   = document.getElementById('fileRemove');
const btnProcess   = document.getElementById('btnProcess');

const progressPanel = document.getElementById('progressPanel');
const progressPct   = document.getElementById('progressPct');
const progressBar   = document.getElementById('progressBar');
const statusText    = document.getElementById('statusText');

const resultPanel = document.getElementById('resultPanel');
const resultIcon  = document.getElementById('resultIcon');
const resultTitle = document.getElementById('resultTitle');
const resultSub   = document.getElementById('resultSub');
const btnDownload = document.getElementById('btnDownload');
const btnReset    = document.getElementById('btnReset');

const macosTip = document.getElementById('macosTip');
const tipCmd   = document.getElementById('tipCmd');
const btnCopy  = document.getElementById('btnCopy');

// ─── State ────────────────────────────────────────────────────────────────────
let selectedFile   = null;
let pollTimer      = null;
let currentTaskId  = null;
let outputFilename = null;

// ─── Icons ────────────────────────────────────────────────────────────────────
const ICON_IMAGE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
  <path stroke-linecap="round" stroke-linejoin="round" d="M21 15l-5-5L5 21"/>
</svg>`;
const ICON_VIDEO = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path stroke-linecap="round" stroke-linejoin="round"
    d="M15 10l4.553-2.277A1 1 0 0121 8.68v6.64a1 1 0 01-1.447.897L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
</svg>`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isVideo(file) {
  return file.type === 'video/mp4' || file.type === 'video/quicktime';
}

function isImage(file) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
}

function showError(msg) {
  resultPanel.classList.add('visible', 'error');
  resultIcon.textContent  = '⚠️';
  resultTitle.textContent = '处理失败，请重试';
  resultSub.textContent   = msg || '服务异常，请稍后再试';
  btnDownload.style.display = 'none';
  btnReset.style.display    = 'block';
}

const statusMap = {
  queued:     '排队中...',
  processing: '优化处理中...',
  done:       '处理完成，准备下载',
  error:      '处理失败，请重试',
};

// ─── File selection ───────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;

  if (!isImage(file) && !isVideo(file)) {
    alert('不支持的文件类型，请上传 JPG / PNG / WEBP / MP4 / MOV');
    return;
  }

  const maxBytes = isVideo(file) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > maxBytes) {
    const limitLabel = isVideo(file) ? '200MB' : '20MB';
    alert(`文件过大，${isVideo(file) ? '视频' : '图片'}最大支持 ${limitLabel}`);
    return;
  }

  selectedFile = file;
  fileNameEl.textContent    = file.name;
  fileSizeEl.textContent    = formatBytes(file.size);
  fileTypeIcon.innerHTML    = isVideo(file) ? ICON_VIDEO : ICON_IMAGE;
  fileInfo.classList.add('visible');
  btnProcess.disabled       = false;

  // Reset any previous result
  resultPanel.classList.remove('visible', 'error');
  progressPanel.classList.remove('visible');
  macosTip.classList.remove('visible');
  btnDownload.style.display = 'inline-flex';
}

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

fileRemove.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.remove('visible');
  btnProcess.disabled = true;
  resultPanel.classList.remove('visible', 'error');
  progressPanel.classList.remove('visible');
  macosTip.classList.remove('visible');
  clearInterval(pollTimer);
});

// Drag & drop
uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// ─── Upload & process ─────────────────────────────────────────────────────────
btnProcess.addEventListener('click', async () => {
  if (!selectedFile) return;
  await startProcessing();
});

async function startProcessing() {
  const file = selectedFile;
  const type = isVideo(file) ? 'video' : 'image';

  // Lock UI
  btnProcess.disabled = true;
  fileRemove.disabled = true;

  // Show progress
  progressPanel.classList.add('visible');
  resultPanel.classList.remove('visible', 'error');
  macosTip.classList.remove('visible');
  setProgress(0, '排队中...');

  try {
    // --- Upload ---
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);

    const uploadRes = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.error || `上传失败 (${uploadRes.status})`);
    }

    const { taskId } = await uploadRes.json();
    currentTaskId = taskId;

    // Cold-start warmup: jump to 10%
    setProgress(10, '优化处理中...');

    // --- Poll ---
    await pollStatus(taskId, type);

  } catch (err) {
    console.error(err);
    showError(err.message);
    btnProcess.disabled  = false;
    fileRemove.disabled  = false;
  }
}

function setProgress(pct, label) {
  progressBar.style.width    = pct + '%';
  progressPct.textContent    = pct + '%';
  statusText.textContent     = label || statusMap[pct === 100 ? 'done' : 'processing'];
}

async function pollStatus(taskId, type) {
  return new Promise((resolve, reject) => {
    let lastPct = 10;
    let elapsed = 0;

    pollTimer = setInterval(async () => {
      elapsed += POLL_INTERVAL_MS;

      try {
        const res  = await fetch(`${API_BASE}/status/${taskId}`);
        if (!res.ok) throw new Error(`状态查询失败 (${res.status})`);
        const data = await res.json();

        const pct   = data.progress ?? lastPct;
        const label = statusMap[data.status] || '处理中...';

        // Smooth progress even without backend increments
        const displayPct = Math.max(lastPct, Math.min(pct, data.status === 'done' ? 100 : 95));
        lastPct = displayPct;
        setProgress(displayPct, label);

        if (data.status === 'done') {
          clearInterval(pollTimer);
          setProgress(100, '处理完成，准备下载');
          showResult(data.downloadUrl, type, taskId);
          resolve();
        } else if (data.status === 'error') {
          clearInterval(pollTimer);
          showError(data.message || '处理失败，请重试');
          btnProcess.disabled = false;
          fileRemove.disabled = false;
          resolve();
        } else if (elapsed > 600_000) {
          // 10-minute timeout
          clearInterval(pollTimer);
          showError('处理超时，请重试');
          btnProcess.disabled = false;
          fileRemove.disabled = false;
          resolve();
        }
      } catch (err) {
        // Network blip — keep polling
        console.warn('Poll error:', err.message);
      }
    }, POLL_INTERVAL_MS);
  });
}

// ─── Result ───────────────────────────────────────────────────────────────────
function showResult(downloadUrl, type, taskId) {
  resultPanel.classList.remove('error');
  resultPanel.classList.add('visible');
  resultIcon.textContent  = '✅';
  resultTitle.textContent = '处理完成';
  resultSub.textContent   = '文件已准备好，点击下载';
  btnDownload.style.display = 'inline-flex';

  // Determine output filename like iPhone album: IMG_XXXX
  const rand4  = String(Math.floor(1000 + Math.random() * 9000));
  outputFilename = `IMG_${rand4}.${type === 'video' ? 'mp4' : 'jpg'}`;
  tipCmd.textContent = `xattr -c ${outputFilename}`;

  btnDownload.href     = downloadUrl;
  btnDownload.download = outputFilename;

  macosTip.classList.add('visible');
  btnProcess.disabled = false;
  fileRemove.disabled = false;
}

// ─── Reset ────────────────────────────────────────────────────────────────────
btnReset.addEventListener('click', () => {
  clearInterval(pollTimer);
  selectedFile   = null;
  currentTaskId  = null;
  outputFilename = null;
  fileInput.value = '';
  fileInfo.classList.remove('visible');
  btnProcess.disabled = true;
  progressPanel.classList.remove('visible');
  resultPanel.classList.remove('visible', 'error');
  macosTip.classList.remove('visible');
  setProgress(0, '');
});

// ─── Copy command ─────────────────────────────────────────────────────────────
btnCopy.addEventListener('click', async () => {
  const cmd = tipCmd.textContent;
  try {
    await navigator.clipboard.writeText(cmd);
    btnCopy.textContent = '已复制';
    btnCopy.classList.add('copied');
    setTimeout(() => {
      btnCopy.textContent = '复制';
      btnCopy.classList.remove('copied');
    }, 2000);
  } catch {
    // Fallback for non-https
    const el = document.createElement('textarea');
    el.value = cmd;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    btnCopy.textContent = '已复制';
    btnCopy.classList.add('copied');
    setTimeout(() => {
      btnCopy.textContent = '复制';
      btnCopy.classList.remove('copied');
    }, 2000);
  }
});
