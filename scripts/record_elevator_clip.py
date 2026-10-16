"""
บันทึกคลิปลิฟต์จำลอง: ขึ้นจากชั้นล่างสุดไปชั้นบนสุด → ลงกลับชั้นล่าง → หยุดชั้นกลาง

เครื่องที่ไม่มี GPU วาดภาพได้ช้ากว่า 1 เฟรม/วินาที จึงหยุดลูปวาดอัตโนมัติ แล้วเดินนาฬิกาของฉากทีละ 1/FPS วินาที
วาดฉากและอ่านภาพจาก canvas ทีละเฟรม (ความเร็วในคลิป = ความเร็วจริงของลิฟต์ในแอป)
แผงสถานะในคลิปวาดจากสถานะลิฟต์ของเฟรมเดียวกัน (ข้อความเดียวกับแผงในแอป) แล้วรวมเป็นวิดีโอด้วย ffmpeg

  python scripts/record_elevator_clip.py [http://localhost:4173] [โฟลเดอร์ผลลัพธ์] [fps]
"""
import base64, io, os, sys, shutil, subprocess, random
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'elevator-clip'
FPS = int(sys.argv[3]) if len(sys.argv) > 3 else 15
FRAMES = os.path.join(OUT, 'frames')
shutil.rmtree(FRAMES, ignore_errors=True)
os.makedirs(FRAMES, exist_ok=True)
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
STEP = 1000 / FPS
FONT_DIR = '/usr/share/fonts/opentype/tlwg'
FB = lambda s: ImageFont.truetype(os.path.join(FONT_DIR, 'Loma-Bold.otf'), s)
FR = lambda s: ImageFont.truetype(os.path.join(FONT_DIR, 'Loma.otf'), s)
n = 0

FRAME_JS = """(step) => {
  const sc = window.__iotFortune.app.scene;
  if (step) sc.debugStepLift(step);
  sc.renderNow();
  const url = sc.renderer.domElement.toDataURL('image/jpeg', 0.92);
  return { url, st: sc.elevatorStatus(), probe: sc.elevatorProbe(), floors: sc.elevatorFloors() };
}"""


def overlay(img, st, floors):
    d = ImageDraw.Draw(img, 'RGBA')
    W, H = img.size
    pw, ph = 330, 196
    x0, y0 = W - pw - 16, H - ph - 16
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], 12, fill=(251, 252, 249, 245), outline=(201, 162, 39), width=3)
    d.text((x0 + 14, y0 + 10), 'ลิฟต์โดยสาร L1', font=FB(19), fill=(29, 42, 46))
    d.rounded_rectangle([x0 + 170, y0 + 11, x0 + pw - 12, y0 + 35], 10, fill=(255, 242, 194), outline=(227, 199, 102))
    d.text((x0 + 180, y0 + 13), 'จำลอง · ไม่ใช่ข้อมูลจริง', font=FB(13), fill=(122, 91, 0))
    d.rounded_rectangle([x0 + 12, y0 + 44, x0 + pw - 12, y0 + 108], 10, fill=(29, 42, 46))
    if st['direction']:  # ลูกศรวาดเป็นรูปทรง (ฟอนต์ไทยไม่มีอักขระ ▲▼)
        ax, ay = x0 + 40, y0 + 76
        tri = [(ax - 16, ay + 10), (ax + 16, ay + 10), (ax, ay - 14)] if st['direction'] == 'up' else [(ax - 16, ay - 10), (ax + 16, ay - 10), (ax, ay + 14)]
        d.polygon(tri, fill=(125, 255, 176))
    d.text((x0 + 70, y0 + 50), st['headline'].replace(st['arrow'], '').strip(), font=FB(22), fill=(255, 255, 255))
    d.text((x0 + 70, y0 + 80), st['doorText'] + (f" · {st['detail']}" if st['detail'] else ''), font=FR(15), fill=(185, 211, 204))
    d.text((x0 + 14, y0 + 130), 'ไปชั้น', font=FB(15), fill=(86, 102, 108))
    for i, f in enumerate(floors):
        cx, cy, r = x0 + 90 + i * 56, y0 + 140, 21
        here = st['atFloor'] == f
        tgt = not st['atFloor'] and st['target'] == f
        alpha = 255 if st['buttonsEnabled'] or here or tgt else 120
        if tgt:
            d.ellipse([cx - r - 5, cy - r - 5, cx + r + 5, cy + r + 5], fill=(201, 162, 39, 90))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(201, 162, 39, alpha) if here else (255, 255, 255, alpha),
                  outline=(143, 113, 22, alpha) if here or tgt else (138, 154, 159, alpha), width=3)
        tw = d.textlength(f, font=FB(18))
        d.text((cx - tw / 2, cy - 12), f, font=FB(18), fill=(255, 255, 255, alpha) if here else (29, 42, 46, alpha))
    d.text((x0 + 14, y0 + ph - 26), 'ปุ่มถูกปิดระหว่างเดินทาง' if not st['buttonsEnabled'] else 'กดเลือกชั้นได้', font=FR(13), fill=(86, 102, 108))
    # หัวคลิป
    d.rounded_rectangle([12, 12, 560, 46], 8, fill=(31, 40, 44, 210))
    d.text((22, 17), 'IoT ฟอร์จูน · ลิฟต์ 3 มิติ (จำลอง) · เวลาในคลิป = เวลาจริงของแอป', font=FB(16), fill=(232, 239, 233))


def frame(page, step):
    global n
    r = page.evaluate(FRAME_JS, step)
    img = Image.open(io.BytesIO(base64.b64decode(r['url'].split(',', 1)[1]))).convert('RGB')
    overlay(img, r['st'], r['floors'])
    img.save(os.path.join(FRAMES, f'{n:05d}.jpg'), quality=92)
    n += 1
    return r


def hold(page, sec):
    for _ in range(int(sec * FPS)):
        frame(page, STEP)


def go(page, floor):
    page.evaluate(f"document.querySelector('.lift-btn[data-floor=\"{floor}\"]').click()")
    for _ in range(3000):
        r = frame(page, STEP)
        if r['probe']['phase'] == 'open' and r['probe']['target'] == floor:
            break
    print('arrived', floor, 'frames', n, flush=True)
    hold(page, 1.2)


with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    page.goto(f'{BASE}/?db=clip{random.randint(1000, 9999)}')
    page.wait_for_selector('[data-testid=lift-panel]', timeout=60000)
    page.add_style_tag(content='.viewport{height:600px !important}')
    page.wait_for_function('() => { const sc = window.__iotFortune.app.scene; return sc.modelLoaded && [...sc.floorGroups.values()].every(g => !g.anim); }', timeout=120000)
    page.evaluate("document.querySelector('[data-testid=lift-cut]').click()")  # เปิดปล่อง + มุมกล้องลิฟต์
    page.wait_for_function('() => !window.__iotFortune.app.scene.tween', timeout=120000)
    page.evaluate('() => { const sc = window.__iotFortune.app.scene; sc.setPaused(true); sc.setManualClock(performance.now()); }')
    floors = page.evaluate('window.__iotFortune.app.scene.elevatorFloors()')
    hold(page, 1.0)
    go(page, floors[-1])
    go(page, floors[0])
    go(page, floors[len(floors) // 2])
    browser.close()

mp4 = os.path.join(OUT, 'elevator-up-down.mp4')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(FRAMES, '%05d.jpg'),
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', mp4], check=True)
gif = os.path.join(OUT, 'elevator-up-down.gif')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', mp4, '-vf',
                'fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer', gif], check=True)
print('frames', n, '→', mp4, gif)
