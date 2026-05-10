"""
StealthMedia — Modal.com Processing App

Deploy:
    modal deploy modal_processor/modal_app.py

Environment secrets required (set in Modal dashboard or via CLI):
    R2_ACCOUNT_ID       Cloudflare account ID
    R2_ACCESS_KEY       R2 S3-compat access key
    R2_SECRET_KEY       R2 S3-compat secret key
    R2_BUCKET_NAME      R2 bucket name  (e.g. stealthmedia-media)
    WORKER_CALLBACK_KEY Shared secret == MODAL_API_KEY in Worker
    WORKER_CALLBACK_URL Cloudflare Worker /internal/callback endpoint
"""

import os
import io
import tempfile
import traceback

import boto3
import modal
import requests

from main import process_image, process_video

# ─── Modal image definition ───────────────────────────────────────────────────

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "ffmpeg",
        "libimage-exiftool-perl",   # provides exiftool binary
        "libgl1",                   # required by opencv headless
        "libglib2.0-0",
    )
    .pip_install(
        "opencv-python-headless==4.9.0.80",
        "Pillow==10.3.0",
        "numpy==1.26.4",
        "boto3==1.34.101",
        "requests==2.31.0",
    )
)

app = modal.App("stealthmedia", image=image)

# ─── Secrets ──────────────────────────────────────────────────────────────────

r2_secret = modal.Secret.from_name("stealthmedia-r2")
cb_secret  = modal.Secret.from_name("stealthmedia-callback")

# ─── R2 helpers ───────────────────────────────────────────────────────────────

def _r2_client():
    account_id = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY"],
        aws_secret_access_key=os.environ["R2_SECRET_KEY"],
        region_name="auto",
    )


def _download(r2, bucket: str, key: str, local_path: str) -> None:
    r2.download_file(bucket, key, local_path)


def _upload(r2, bucket: str, key: str, local_path: str, content_type: str) -> None:
    r2.upload_file(
        local_path,
        bucket,
        key,
        ExtraArgs={"ContentType": content_type},
    )


# ─── Callback helper ──────────────────────────────────────────────────────────

def _callback(task_id: str, status: str, progress: int, message: str = "") -> None:
    """Push status update back to the Cloudflare Worker."""
    url  = os.environ.get("WORKER_CALLBACK_URL", "")
    key  = os.environ.get("WORKER_CALLBACK_KEY", "")
    if not url:
        print(f"[callback] no URL configured — skip ({status} {progress}%)")
        return

    payload = {"taskId": task_id, "status": status, "progress": progress}
    if message:
        payload["message"] = message

    try:
        resp = requests.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {key}"},
            timeout=10,
        )
        resp.raise_for_status()
    except Exception as exc:   # noqa: BLE001
        print(f"[callback] failed: {exc}")


# ─── Main function (HTTP endpoint) ────────────────────────────────────────────

@app.function(
    secrets=[r2_secret, cb_secret],
    timeout=300,       # 5 min hard limit
    memory=2048,       # MB
    cpu=2,
    # Keep one container warm to reduce cold-start latency
    keep_warm=1,
)
@modal.web_endpoint(method="POST", label="process-media")
def process_media(payload: dict) -> dict:
    """
    Expected payload:
        task_id      str   UUID from Worker
        file_type    str   "image" | "video"
        input_key    str   R2 key  e.g. input/{taskId}/source.jpg
        output_key   str   R2 key  e.g. output/{taskId}/result.jpg
        callback_url str   (optional override; normally from secret)
    """
    task_id    = payload["task_id"]
    file_type  = payload["file_type"]
    input_key  = payload["input_key"]
    output_key = payload["output_key"]

    # Allow per-request callback URL override (Worker sends this)
    if "callback_url" in payload and payload["callback_url"]:
        os.environ["WORKER_CALLBACK_URL"] = payload["callback_url"]

    bucket = os.environ["R2_BUCKET_NAME"]
    r2     = _r2_client()

    ext          = input_key.rsplit(".", 1)[-1].lower()
    content_type = "video/mp4" if file_type == "video" else "image/jpeg"

    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            in_path  = os.path.join(tmp_dir, f"source.{ext}")
            out_path = os.path.join(tmp_dir, f"result.{ext}")

            # ── 1. Download input from R2 ─────────────────────────────────
            _callback(task_id, "processing", 10)
            _download(r2, bucket, input_key, in_path)

            # ── 2. Process ────────────────────────────────────────────────
            _callback(task_id, "processing", 20)
            if file_type == "video":
                process_video(in_path, out_path)
            else:
                process_image(in_path, out_path)

            # ── 3. Upload result to R2 ────────────────────────────────────
            _callback(task_id, "processing", 85)
            _upload(r2, bucket, output_key, out_path, content_type)

            # ── 4. Clean up input object ──────────────────────────────────
            try:
                r2.delete_object(Bucket=bucket, Key=input_key)
            except Exception:   # noqa: BLE001
                pass  # non-fatal; Worker cron will clean up later

        # ── 5. Mark done ──────────────────────────────────────────────────
        _callback(task_id, "done", 100)
        return {"ok": True, "task_id": task_id}

    except Exception as exc:   # noqa: BLE001
        tb = traceback.format_exc()
        print(f"[process_media] ERROR task={task_id}\n{tb}")
        _callback(task_id, "error", 0, message="处理失败，请重试")
        return {"ok": False, "task_id": task_id, "error": str(exc)}
