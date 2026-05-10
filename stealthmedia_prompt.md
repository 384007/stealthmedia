# 任务：开发 StealthMedia 图片/视频AI检测规避处理工具

## 产品目标
用户上传AI生成的图片或视频，系统自动处理后输出能通过主流社交平台（小红书、抖音、微博、Instagram、TikTok、X）AI检测的文件。界面极简，只有上传和下载，所有技术处理对用户完全不可见。

---

## 技术架构

```
用户浏览器（Cloudflare Pages）
    ↓ 上传文件
Cloudflare Worker（API网关）
    ↓ 存储原文件
Cloudflare R2（临时存储）
    ↓ 触发处理任务
Modal.com（Python + ffmpeg处理引擎）
    ↓ 写回处理结果
Cloudflare R2（输出存储）
    ↓ 返回下载链接
用户浏览器
```

### 前端：Cloudflare Pages
- 框架：React 或纯HTML+JS均可
- 路由：单页应用
- 功能：上传文件、显示进度条、下载结果
- **绝对不能暴露**：ffmpeg参数、滤镜名称、编码器、处理步骤、GPS坐标生成逻辑

### 后端：Cloudflare Workers
- 接收上传请求，生成唯一任务ID
- 将原始文件写入 R2 bucket（路径：`input/{taskId}/filename`）
- 通过 HTTP 触发 Modal.com 处理任务
- 提供轮询接口 `GET /api/status/{taskId}` 返回状态
- 处理完成后生成 R2 预签名下载链接（有效期1小时）
- 24小时后自动删除 R2 文件（用 Workers Cron）

### 处理引擎：Modal.com
- Python 3.11 + ffmpeg + opencv-python + Pillow + numpy + exiftool
- 接收任务：文件类型（image/video）、R2输入路径、R2输出路径
- 处理完成后将结果写回 R2

---

## 核心处理逻辑

### 图片处理流程（Python + OpenCV）

```python
def process_image(input_path, output_path):
    """
    目标：让AI生成图片通过社交平台视觉检测
    """
    img = cv2.imread(input_path)
    h, w = img.shape[:2]
    f = img.astype(np.float32) / 255.0
    
    # 1. Bayer传感器噪声（模拟真实CMOS）
    # 绿通道噪声较小（真实相机Bayer pattern特性）
    # 蓝通道噪声较大
    noise = np.random.normal(0, 0.016, f.shape).astype(np.float32)
    bayer_weight = np.ones_like(f)
    bayer_weight[:,:,1] *= 0.68   # 绿通道
    bayer_weight[:,:,0] *= 1.25   # 蓝通道
    f = np.clip(f + noise * bayer_weight, 0, 1)
    
    # 2. 色差（Chromatic Aberration）
    # 蓝通道轻微空间偏移，模拟真实镜头边缘色差
    b, g, r = cv2.split(f)
    M = np.float32([[1, 0, 0.5], [0, 1, 0.3]])
    b = cv2.warpAffine(b, M, (w, h))
    f = cv2.merge([b, g, r])
    
    # 3. 镜头暗角（Vignette）
    Y, X = np.ogrid[:h, :w]
    dist = np.sqrt((X-w/2)**2 + (Y-h/2)**2)
    vignette = 1 - 0.25 * (dist / np.sqrt((w/2)**2+(h/2)**2))**2.0
    f = f * vignette[:,:,np.newaxis]
    
    # 4. 桶形畸变（手机广角镜头特征）
    K = np.array([[w*1.08,0,w/2],[0,w*1.08,h/2],[0,0,1]], dtype=np.float32)
    D = np.array([-0.06, 0.015, 0, 0], dtype=np.float32)
    img_u8 = (np.clip(f,0,1)*255).astype(np.uint8)
    f = cv2.undistort(img_u8, K, D).astype(np.float32)/255.0
    
    # 5. 色温不均匀（高光偏冷/阴影偏暖，模拟真实光源）
    lum = 0.299*f[:,:,2] + 0.587*f[:,:,1] + 0.114*f[:,:,0]
    hi = (lum > 0.72).astype(np.float32)
    sh = (lum < 0.28).astype(np.float32)
    f[:,:,0] += 0.012*hi;  f[:,:,2] -= 0.006*hi   # 高光加蓝
    f[:,:,2] += 0.014*sh;  f[:,:,0] -= 0.007*sh   # 阴影加暖
    f = np.clip(f*1.03 + 0.004, 0, 1)
    
    # 6. 近景景深模糊（地面/下边缘）
    result = (f*255).astype(np.uint8)
    ground = result[int(h*0.85):, :]
    result[int(h*0.85):] = cv2.GaussianBlur(ground, (5,5), 1.2)
    
    # 7. 存为JPEG（Q87，引入真实压缩artifacts）
    cv2.imwrite(output_path, result,
                [cv2.IMWRITE_JPEG_QUALITY, 87,
                 cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    
    # 8. 注入相机EXIF元数据
    inject_image_exif(output_path)
```

### 视频处理流程（ffmpeg + Python）

```python
def process_video(input_path, output_path):
    """
    目标：清除C2PA签名/编码器痕迹，注入iPhone元数据，
    调整视觉特征通过社交平台AI分类器
    """
    
    # === Pass 1：缩放扰动 + 破坏隐写水印 + 清除所有元数据 ===
    tmp1 = input_path + "_p1.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-i", input_path,
        "-vf", "scale=iw*0.996:ih*0.996,hqdn3d=2:1.5:4:3,noise=alls=12:allf=t+u",
        "-c:v", "libx264", "-crf", "24", "-preset", "slow",
        "-x264-params", "info=0",
        "-pix_fmt", "yuv420p",
        "-an", "-map_metadata", "-1", "-fflags", "+bitexact",
        tmp1
    ], check=True)
    
    # === Pass 2：还原分辨率 + 视觉处理 + 色调偏移 ===
    tmp2 = input_path + "_p2.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-i", tmp1,
        "-vf", ",".join([
            "scale=1080:1920",           # 9:16竖屏，社交平台标准
            "unsharp=5:5:0.6:3:3:0",    # 消除AI蜡质感
            "vignette=PI/4.5",           # 镜头暗角
            "eq=contrast=0.97:saturation=0.88:brightness=0.02:gamma=1.02:gamma_r=1.025:gamma_b=0.975",
            "noise=alls=6:allf=t",       # 胶片噪点
            "curves=r='0/0.02 0.5/0.52 1/0.98':g='0/0.01 0.5/0.505 1/0.99':b='0/0 0.5/0.49 1/0.97'"
        ]),
        "-c:v", "libx264", "-crf", "20", "-preset", "slow",
        "-x264-params", "info=0:keyint=60:min-keyint=60:scenecut=0",
        "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-color_range", "tv",
        "-an", "-map_metadata", "-1", "-fflags", "+bitexact",
        tmp2
    ], check=True)
    
    # === 添加真实环境音轨（户外粉噪+微风）===
    tmp3 = input_path + "_p3.mp4"
    duration = get_video_duration(tmp2)
    subprocess.run([
        "ffmpeg", "-y",
        "-i", tmp2,
        "-f", "lavfi",
        "-i", f"anoisesrc=color=pink:amplitude=0.02:sample_rate=44100",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-t", str(duration),
        "-movflags", "+faststart", "-map_metadata", "-1",
        tmp3
    ], check=True)
    
    # === 二进制清除所有编码器/工具字符串 ===
    clean_binary_strings(tmp3, output_path)
    
    # === 注入iPhone QuickTime元数据 ===
    inject_video_metadata(output_path)
    
    # 清理临时文件
    for f in [tmp1, tmp2, tmp3]:
        os.unlink(f)


def clean_binary_strings(input_path, output_path):
    """
    二进制清除所有AI平台/编码器痕迹字符串
    包括：C2PA签名、FFmpeg、libx264、Lavc、Lavf、ExifTool等
    """
    import shutil
    shutil.copy(input_path, output_path)
    
    with open(output_path, 'rb') as f:
        data = bytearray(f.read())
    
    targets = [
        b'Signature',   # C2PA/Grok签名
        b'Grok', b'Aurora', b'xAI',
        b'FFmpeg', b'ffmpeg',
        b'Lavf', b'Lavc',
        b'libx264', b'x264',
        b'ExifTool', b'exiftool',
        b'Runway', b'Pika', b'Kling',
        b'crf=', b'keyint=', b'bframes=', b'rc_lookahead=',
    ]
    
    for target in targets:
        idx = 0
        while True:
            pos = data.find(target, idx)
            if pos == -1:
                break
            # 找到字符串末尾（null字节），全部清零
            end = pos
            while end < min(pos + 300, len(data)) and data[end] != 0:
                data[end] = 0
                end += 1
            idx = pos + 1
    
    with open(output_path, 'wb') as f:
        f.write(data)


def inject_video_metadata(filepath, gps_preset='florida'):
    """
    注入完整iPhone QuickTime元数据
    GPS预设：florida（高尔夫场景）/ california / newyork
    """
    gps_data = {
        'florida':    {'lat': 28.3554, 'lng': -81.5122, 'alt': 52.3, 'tz': '-04:00'},
        'california': {'lat': 34.0522, 'lng': -118.2437, 'alt': 71.0, 'tz': '-07:00'},
        'newyork':    {'lat': 40.7580, 'lng': -73.9855, 'alt': 10.0, 'tz': '-04:00'},
    }
    gps = gps_data[gps_preset]
    
    # 生成随机但合理的拍摄时间（近3个月内）
    import random
    from datetime import datetime, timedelta
    shoot_date = datetime.now() - timedelta(days=random.randint(7, 90))
    date_str = shoot_date.strftime('%Y:%m:%d %H:%M:%S')
    
    subprocess.run([
        'exiftool', '-overwrite_original',
        '-Make=Apple',
        '-Model=iPhone 15 Pro',
        '-Software=17.5.1',
        f'-CreateDate={date_str}',
        f'-ModifyDate={date_str}',
        f'-TrackCreateDate={date_str}',
        f'-TrackModifyDate={date_str}',
        f'-MediaCreateDate={date_str}',
        f'-MediaModifyDate={date_str}',
        f'-ContentCreateDate={date_str}{gps["tz"]}',
        '-n',
        f'-GPSLatitude={gps["lat"]}',
        f'-GPSLatitudeRef={"N" if gps["lat"]>0 else "S"}',
        f'-GPSLongitude={abs(gps["lng"])}',
        f'-GPSLongitudeRef={"W" if gps["lng"]<0 else "E"}',
        f'-GPSAltitude={gps["alt"]}',
        '-GPSAltitudeRef=Above Sea Level',
        '-GPSSpeed=0.0', '-GPSSpeedRef=K',
        '-XMP:all=',
        filepath
    ], check=True)
    
    # 清除exiftool写入时留下的痕迹
    with open(filepath, 'rb') as f:
        data = bytearray(f.read())
    for t in [b'ExifTool', b'Image::ExifTool']:
        idx = 0
        while True:
            pos = data.find(t, idx)
            if pos == -1: break
            end = pos
            while end < min(pos+100, len(data)) and data[end] != 0:
                data[end] = 0; end += 1
            idx = pos + 1
    with open(filepath, 'wb') as f:
        f.write(data)


def inject_image_exif(filepath):
    subprocess.run([
        'exiftool', '-overwrite_original',
        '-Make=Apple',
        '-Model=iPhone 15 Pro',
        '-LensModel=iPhone 15 Pro back triple camera 6.765mm f/1.78',
        '-FocalLength=6.8mm',
        '-FocalLengthIn35mmFormat=24mm',
        '-ApertureValue=1.78',
        '-FNumber=1.8',
        '-ExposureTime=1/1000',
        '-ISO=64',
        '-Flash=No flash',
        '-ColorSpace=sRGB',
        '-Software=17.5.1',
        '-XMP:all=',
        filepath
    ], check=True)
```

---

## API 接口定义

### POST /api/upload
```
Request: multipart/form-data
  file: 图片（jpg/png/webp）或视频（mp4/mov）
  type: "image" | "video"

Response: {
  taskId: "uuid-v4",
  status: "queued"
}
```

### GET /api/status/:taskId
```
Response: {
  taskId: string,
  status: "queued" | "processing" | "done" | "error",
  progress: 0-100,
  downloadUrl?: string   // 仅status=done时返回，R2预签名URL
}
```

### DELETE /api/task/:taskId（可选）
用户主动删除文件

---

## 前端UI规范

### 界面要求
- **极简风格**，暗色系（#0a0a0a背景）
- 品牌名：**StealthMedia** 或自定
- 上传区：拖拽或点击上传，支持jpg/png/mp4/mov
- 进度：显示进度条 + 状态文字（Processing... / Ready）
- 下载：完成后显示下载按钮
- **绝对不显示**：ffmpeg、滤镜、编码参数、GPS、exiftool等任何技术词汇
- 文案用：「优化中」「处理完成」「下载文件」

### 状态文案映射（对用户显示）
```
queued      → 「排队中...」
processing  → 「优化处理中...」
done        → 「处理完成，点击下载」
error       → 「处理失败，请重试」
```

---

## 文件限制
- 图片：最大 20MB，支持 jpg/png/webp
- 视频：最大 200MB，支持 mp4/mov
- 输出保留时间：24小时后自动删除

---

## Modal.com 部署配置

```python
import modal

app = modal.App("stealthmedia")

image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg", "libimage-exiftool-perl")
    .pip_install("opencv-python-headless", "Pillow", "numpy", "boto3")
)

@app.function(
    image=image,
    timeout=300,
    memory=2048,
)
def process_media(task_id: str, file_type: str, r2_input_key: str, r2_output_key: str):
    # 从R2下载 → 处理 → 上传回R2 → 通知Worker完成
    ...
```

---

## Cloudflare Worker 关键逻辑

```javascript
// wrangler.toml 需要绑定：
// R2 bucket: MEDIA_BUCKET
// KV: TASK_STATUS
// Secret: MODAL_API_KEY

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      const formData = await request.formData();
      const file = formData.get('file');
      const type = formData.get('type');
      const taskId = crypto.randomUUID();
      
      // 存R2
      await env.MEDIA_BUCKET.put(`input/${taskId}/${file.name}`, file.stream());
      
      // 记录状态
      await env.TASK_STATUS.put(taskId, JSON.stringify({
        status: 'queued', progress: 0, filename: file.name, type
      }));
      
      // 触发Modal
      await triggerModal(env, taskId, type, file.name);
      
      return Response.json({ taskId, status: 'queued' });
    }
    
    if (request.method === 'GET' && url.pathname.startsWith('/api/status/')) {
      const taskId = url.pathname.split('/').pop();
      const data = JSON.parse(await env.TASK_STATUS.get(taskId) || '{}');
      
      if (data.status === 'done') {
        // 生成R2预签名下载链接
        const downloadUrl = await generatePresignedUrl(env, `output/${taskId}/result`);
        return Response.json({ ...data, downloadUrl });
      }
      
      return Response.json(data);
    }
  }
}
```

---

## 安全要求
- 上传文件不存原始文件名，用 `{taskId}/{uuid}` 命名
- R2 bucket 设为私有，只通过预签名URL访问
- Worker 不返回任何处理参数信息
- 前端无法通过任何接口获取处理逻辑
- CORS 只允许自己的域名

---

## 目录结构

```
stealthmedia/
├── frontend/                 # Cloudflare Pages
│   ├── index.html
│   ├── app.js
│   └── style.css
├── worker/                   # Cloudflare Worker
│   ├── src/index.js
│   └── wrangler.toml
└── modal_processor/          # Modal.com处理引擎
    ├── main.py               # 包含上述所有处理函数
    ├── requirements.txt
    └── modal_app.py
```

---

## 开发注意事项

1. **Modal冷启动**：首次处理约15-30秒，进度条从0跳到10%提示用户等待
2. **视频大文件**：用R2 multipart upload，不要用Worker直接转发（Worker内存限制128MB）
3. **exiftool依赖**：Modal image必须 apt_install libimage-exiftool-perl
4. **GPS坐标**：根据视频内容场景自动选择匹配的地理位置预设，不暴露给用户
5. **文件名输出**：图片输出 `IMG_{random4digit}.jpg`，视频输出 `IMG_{random4digit}.mp4`，模拟iPhone相册命名
6. **macOS下载来源**：在下载页面提示用户下载后在终端运行 `xattr -c 文件名` 清除系统来源记录（可以做成一键复制命令的按钮）
