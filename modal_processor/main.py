"""
StealthMedia — Core Processing Engine
Image and video processing logic to bypass AI-detection on social platforms.
All technical details are intentionally opaque to end users.
"""

import os
import random
import subprocess
import shutil
from datetime import datetime, timedelta

import cv2
import numpy as np


# ─── Image Processing ────────────────────────────────────────────────────────

def process_image(input_path: str, output_path: str) -> None:
    """
    Apply a series of camera-realistic transforms to an image so that
    AI-generated-content classifiers treat it as a natural photograph.
    """
    img = cv2.imread(input_path)
    if img is None:
        raise ValueError(f"Cannot read image: {input_path}")

    h, w = img.shape[:2]
    f = img.astype(np.float32) / 255.0

    # 1. Bayer sensor noise (CMOS characteristic: G channel quieter, B louder)
    noise = np.random.normal(0, 0.016, f.shape).astype(np.float32)
    bayer_weight = np.ones_like(f)
    bayer_weight[:, :, 1] *= 0.68   # green
    bayer_weight[:, :, 0] *= 1.25   # blue
    f = np.clip(f + noise * bayer_weight, 0, 1)

    # 2. Chromatic aberration — slight blue-channel spatial shift
    b, g, r = cv2.split(f)
    M = np.float32([[1, 0, 0.5], [0, 1, 0.3]])
    b = cv2.warpAffine(b, M, (w, h))
    f = cv2.merge([b, g, r])

    # 3. Lens vignette
    Y, X = np.ogrid[:h, :w]
    dist = np.sqrt((X - w / 2) ** 2 + (Y - h / 2) ** 2)
    vignette = 1 - 0.25 * (dist / np.sqrt((w / 2) ** 2 + (h / 2) ** 2)) ** 2.0
    f = f * vignette[:, :, np.newaxis]

    # 4. Barrel distortion (wide-angle phone lens)
    K = np.array([[w * 1.08, 0, w / 2],
                  [0, w * 1.08, h / 2],
                  [0, 0, 1]], dtype=np.float32)
    D = np.array([-0.06, 0.015, 0, 0], dtype=np.float32)
    img_u8 = (np.clip(f, 0, 1) * 255).astype(np.uint8)
    f = cv2.undistort(img_u8, K, D).astype(np.float32) / 255.0

    # 5. Non-uniform colour temperature (highlights cool, shadows warm)
    lum = 0.299 * f[:, :, 2] + 0.587 * f[:, :, 1] + 0.114 * f[:, :, 0]
    hi = (lum > 0.72).astype(np.float32)
    sh = (lum < 0.28).astype(np.float32)
    f[:, :, 0] += 0.012 * hi;  f[:, :, 2] -= 0.006 * hi   # highlights: add blue
    f[:, :, 2] += 0.014 * sh;  f[:, :, 0] -= 0.007 * sh   # shadows: add warm
    f = np.clip(f * 1.03 + 0.004, 0, 1)

    # 6. Near-ground shallow depth-of-field blur (bottom 15%)
    result = (f * 255).astype(np.uint8)
    ground = result[int(h * 0.85):, :]
    result[int(h * 0.85):] = cv2.GaussianBlur(ground, (5, 5), 1.2)

    # 7. JPEG compression at Q87 (introduces realistic DCT artifacts)
    cv2.imwrite(output_path, result,
                [cv2.IMWRITE_JPEG_QUALITY, 87,
                 cv2.IMWRITE_JPEG_OPTIMIZE, 1])

    # 8. Inject realistic camera EXIF
    inject_image_exif(output_path)


# ─── Video Processing ─────────────────────────────────────────────────────────

def process_video(input_path: str, output_path: str) -> None:
    """
    Three-pass ffmpeg pipeline that:
      1. Strips watermarks / C2PA signatures / encoder fingerprints
      2. Applies visual corrections that defeat AI classifiers
      3. Adds a natural-sounding ambient audio track
    Then binary-patches out any remaining tool strings and injects
    full iPhone QuickTime metadata.
    """
    tmp1 = input_path + "_p1.mp4"
    tmp2 = input_path + "_p2.mp4"
    tmp3 = input_path + "_p3.mp4"

    try:
        # ── Pass 1: scale perturbation + denoise + film-grain + strip metadata ──
        _run([
            "ffmpeg", "-y", "-i", input_path,
            "-vf", "scale=iw*0.996:ih*0.996,hqdn3d=2:1.5:4:3,noise=alls=12:allf=t+u",
            "-c:v", "libx264", "-crf", "24", "-preset", "slow",
            "-x264-params", "info=0",
            "-pix_fmt", "yuv420p",
            "-an", "-map_metadata", "-1", "-fflags", "+bitexact",
            tmp1,
        ])

        # ── Pass 2: restore resolution + visual grading ───────────────────────
        vf_chain = ",".join([
            "scale=1080:1920:force_original_aspect_ratio=decrease,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2",   # 9:16 with letterbox if needed
            "unsharp=5:5:0.6:3:3:0",               # remove AI waxy sheen
            "vignette=PI/4.5",                      # lens falloff
            "eq=contrast=0.97:saturation=0.88:brightness=0.02"
            ":gamma=1.02:gamma_r=1.025:gamma_b=0.975",
            "noise=alls=6:allf=t",                  # film grain
            "curves=r='0/0.02 0.5/0.52 1/0.98'"
            ":g='0/0.01 0.5/0.505 1/0.99'"
            ":b='0/0 0.5/0.49 1/0.97'",            # tone curve
        ])
        _run([
            "ffmpeg", "-y", "-i", tmp1,
            "-vf", vf_chain,
            "-c:v", "libx264", "-crf", "20", "-preset", "slow",
            "-x264-params", "info=0:keyint=60:min-keyint=60:scenecut=0",
            "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709",
            "-color_trc", "bt709", "-color_range", "tv",
            "-an", "-map_metadata", "-1", "-fflags", "+bitexact",
            tmp2,
        ])

        # ── Pass 3: add ambient pink noise audio (outdoor breeze) ─────────────
        duration = _get_duration(tmp2)
        _run([
            "ffmpeg", "-y",
            "-i", tmp2,
            "-f", "lavfi",
            "-i", f"anoisesrc=color=pink:amplitude=0.02:sample_rate=44100",
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-t", str(duration),
            "-movflags", "+faststart", "-map_metadata", "-1",
            tmp3,
        ])

        # ── Binary scrub: zero out all encoder/AI-tool strings ────────────────
        clean_binary_strings(tmp3, output_path)

        # ── Inject iPhone QuickTime metadata ──────────────────────────────────
        inject_video_metadata(output_path)

    finally:
        for tmp in [tmp1, tmp2, tmp3]:
            if os.path.exists(tmp):
                os.unlink(tmp)


# ─── Binary scrub ─────────────────────────────────────────────────────────────

def clean_binary_strings(input_path: str, output_path: str) -> None:
    """
    Zero-out every occurrence of known AI-platform, encoder, and tool
    identifier strings found in the raw binary container.
    """
    shutil.copy(input_path, output_path)

    with open(output_path, "rb") as fh:
        data = bytearray(fh.read())

    targets = [
        b"Signature",
        b"Grok", b"Aurora", b"xAI",
        b"FFmpeg", b"ffmpeg",
        b"Lavf", b"Lavc",
        b"libx264", b"x264",
        b"ExifTool", b"exiftool",
        b"Runway", b"Pika", b"Kling",
        b"crf=", b"keyint=", b"bframes=", b"rc_lookahead=",
        b"C2PA", b"c2pa",
    ]

    for target in targets:
        idx = 0
        while True:
            pos = data.find(target, idx)
            if pos == -1:
                break
            end = pos
            while end < min(pos + 300, len(data)) and data[end] != 0:
                data[end] = 0
                end += 1
            idx = pos + 1

    with open(output_path, "wb") as fh:
        fh.write(data)


# ─── EXIF / metadata injection ───────────────────────────────────────────────

# GPS presets — matched automatically based on content type / random selection
_GPS_PRESETS = {
    "florida":    {"lat": 28.3554,  "lng": -81.5122,  "alt": 52.3,  "tz": "-04:00"},
    "california": {"lat": 34.0522,  "lng": -118.2437, "alt": 71.0,  "tz": "-07:00"},
    "newyork":    {"lat": 40.7580,  "lng": -73.9855,  "alt": 10.0,  "tz": "-04:00"},
    "texas":      {"lat": 30.2672,  "lng": -97.7431,  "alt": 148.8, "tz": "-05:00"},
    "hawaii":     {"lat": 21.3069,  "lng": -157.8583, "alt": 3.0,   "tz": "-10:00"},
}


def _random_shoot_date() -> str:
    """Return a random capture date within the past 3 months."""
    delta = random.randint(7, 90)
    d = datetime.now() - timedelta(days=delta)
    # Vary the time of day realistically (7 am – 8 pm)
    d = d.replace(
        hour=random.randint(7, 20),
        minute=random.randint(0, 59),
        second=random.randint(0, 59),
    )
    return d.strftime("%Y:%m:%d %H:%M:%S")


def inject_image_exif(filepath: str) -> None:
    """Inject realistic iPhone 15 Pro EXIF into a JPEG."""
    date_str = _random_shoot_date()
    _run([
        "exiftool", "-overwrite_original",
        "-Make=Apple",
        "-Model=iPhone 15 Pro",
        "-LensModel=iPhone 15 Pro back triple camera 6.765mm f/1.78",
        "-FocalLength=6.8mm",
        "-FocalLengthIn35mmFormat=24mm",
        "-ApertureValue=1.78",
        "-FNumber=1.8",
        f"-ExposureTime=1/{random.randint(500, 2000)}",
        f"-ISO={random.choice([32, 50, 64, 80, 100])}",
        "-Flash=No flash",
        "-ColorSpace=sRGB",
        "-Software=17.5.1",
        f"-DateTimeOriginal={date_str}",
        f"-CreateDate={date_str}",
        "-XMP:all=",
        filepath,
    ])
    _scrub_exiftool_strings(filepath)


def inject_video_metadata(filepath: str, gps_preset: str | None = None) -> None:
    """Inject full iPhone 15 Pro QuickTime metadata + GPS into a video."""
    if gps_preset is None:
        gps_preset = random.choice(list(_GPS_PRESETS.keys()))

    gps      = _GPS_PRESETS[gps_preset]
    date_str = _random_shoot_date()
    lat_ref  = "N" if gps["lat"] >= 0 else "S"
    lng_ref  = "W" if gps["lng"] < 0  else "E"

    _run([
        "exiftool", "-overwrite_original",
        "-Make=Apple",
        "-Model=iPhone 15 Pro",
        "-Software=17.5.1",
        f"-CreateDate={date_str}",
        f"-ModifyDate={date_str}",
        f"-TrackCreateDate={date_str}",
        f"-TrackModifyDate={date_str}",
        f"-MediaCreateDate={date_str}",
        f"-MediaModifyDate={date_str}",
        f"-ContentCreateDate={date_str}{gps['tz']}",
        "-n",
        f"-GPSLatitude={gps['lat']}",
        f"-GPSLatitudeRef={lat_ref}",
        f"-GPSLongitude={abs(gps['lng'])}",
        f"-GPSLongitudeRef={lng_ref}",
        f"-GPSAltitude={gps['alt']}",
        "-GPSAltitudeRef=Above Sea Level",
        "-GPSSpeed=0.0",
        "-GPSSpeedRef=K",
        "-XMP:all=",
        filepath,
    ])
    _scrub_exiftool_strings(filepath)


def _scrub_exiftool_strings(filepath: str) -> None:
    """Remove the ExifTool signature that exiftool itself writes into files."""
    with open(filepath, "rb") as fh:
        data = bytearray(fh.read())

    for target in [b"ExifTool", b"Image::ExifTool"]:
        idx = 0
        while True:
            pos = data.find(target, idx)
            if pos == -1:
                break
            end = pos
            while end < min(pos + 100, len(data)) and data[end] != 0:
                data[end] = 0
                end += 1
            idx = pos + 1

    with open(filepath, "wb") as fh:
        fh.write(data)


# ─── ffmpeg helpers ───────────────────────────────────────────────────────────

def _run(cmd: list[str]) -> None:
    """Run a subprocess, raise on non-zero exit."""
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(cmd[:4])}\n"
            + result.stderr.decode(errors="replace")[-2000:]
        )


def _get_duration(path: str) -> float:
    """Return video duration in seconds via ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    try:
        return float(result.stdout.decode().strip())
    except ValueError:
        return 30.0   # safe fallback
