"""
ดึง "แนวผนัง" จากภาพผังชั้นที่ได้รับ เพื่อนำไปยกเป็นผนัง 3D (สไตล์ผังตัดสามมิติ)

  - ผังห้าง (สีชมพู/ส้ม/เขียว = พื้นที่เช่า): ผนังหน้าร้าน = ขอบของพื้นที่เช่าที่ติดทางเดิน
    และเส้นแบ่งร้าน = เส้นสีขาวยาว ๆ ภายในพื้นที่เช่า (ตัดตัวอักษร/ตัวเลขที่สั้นออก)
  - ผังสำนักงาน: ผนัง/เสา = เส้นสีเข้มที่ต่อเนื่อง (ตัดตัวอักษรขนาดเล็กออก)

ผลลัพธ์เป็นมาสก์ความละเอียดต่ำลง และสี่เหลี่ยมแบบ greedy สำหรับสร้างกล่อง
พิกัดเป็นพิกเซลของภาพผังที่ครอปแล้ว (แมปเป็นพิกัดโมเดลแบบเดียวกับพื้นผิวผังในแอป)
ผลลัพธ์เป็นแผนภาพจากภาพ ไม่ใช่แบบก่อสร้าง
"""
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def _hsv(img):
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1); mn = a.min(-1)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return a, s, mx


def _keep_long(mask, min_len, min_area=0):
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return mask
    sl = ndi.find_objects(lab)
    areas = ndi.sum(mask, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    for i, s in enumerate(sl, start=1):
        h = s[0].stop - s[0].start; w = s[1].stop - s[1].start
        if max(h, w) >= min_len or areas[i - 1] >= min_area > 0:
            keep[i] = True
    return keep[lab]


def _thin_lines(mask, min_len, max_thick):
    """เก็บเฉพาะชิ้นที่ยาวและบาง (เส้น) ตัดตัวอักษร/ตัวเลขที่เป็นก้อน"""
    lab, n = ndi.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return mask
    sl = ndi.find_objects(lab)
    areas = ndi.sum(mask, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    for i, sli in enumerate(sl, start=1):
        h = sli[0].stop - sli[0].start; w = sli[1].stop - sli[1].start
        L = max(h, w)
        if L >= min_len and areas[i - 1] / L <= max_thick:
            keep[i] = True
    return keep[lab]


def mall_walls(path):
    img = Image.open(path)
    a, s, v = _hsv(img)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    tenant = (s > 0.30) & (v > 0.45)
    mint = (g > r + 0.06) & (g > b + 0.02) & (v > 0.72) & (s > 0.12) & (s <= 0.30)  # พื้นที่ผู้เช่ารายใหญ่ (สีเขียวมิ้นต์)
    shop = tenant | mint
    shop = ndi.binary_opening(shop, iterations=1)
    closed = ndi.binary_closing(shop, structure=np.ones((3, 3)), iterations=3)
    closed = ndi.binary_fill_holes(closed)
    # ตัดก้อนเล็ก ๆ (ไอคอน/ป้าย) ที่ไม่ใช่พื้นที่เช่า
    closed = _keep_long(closed, 26, min_area=400) & closed
    edge = closed & ~ndi.binary_erosion(closed, iterations=2)
    # เส้นแบ่งร้าน = เส้นบางที่สว่างกว่าสีพื้นร้านรอบข้าง (สีอ่อนของสีเดียวกันหลังย่อภาพ)
    minc = a.min(-1)
    local = ndi.median_filter(minc, size=9)
    cand = (minc - local > 0.16) & ndi.binary_erosion(closed, iterations=1)
    seps = _thin_lines(cand, min_len=26, max_thick=3.2)
    seps = ndi.binary_dilation(seps, iterations=1)
    return edge | seps


def office_walls(path):
    img = Image.open(path)
    a, s, v = _hsv(img)
    dark = (v < 0.42) & ((s < 0.35) | (v < 0.25))  # สีเกือบดำมีค่า saturation แกว่ง จึงไม่ใช้กับพิกเซลมืดมาก
    walls = _keep_long(dark, 30, min_area=110) & dark
    return ndi.binary_dilation(walls, iterations=1)


def downsample(mask, f):
    h, w = mask.shape
    H, W = h // f, w // f
    m = mask[:H * f, :W * f].reshape(H, f, W, f)
    return m.any(axis=(1, 3))


def greedy_rects(mask):
    """รวมเซลล์เป็นสี่เหลี่ยม: รวมตามแถว แล้วรวมแถวที่มีช่วงตรงกันลงมา คืน (x0, y0, x1, y1) แบบ exclusive"""
    H, W = mask.shape
    open_runs = {}
    rects = []
    for y in range(H + 1):
        runs = set()
        if y < H:
            row = mask[y]
            x = 0
            while x < W:
                if row[x]:
                    x0 = x
                    while x < W and row[x]:
                        x += 1
                    runs.add((x0, x))
                else:
                    x += 1
        nxt = {}
        for run, y0 in open_runs.items():
            if run in runs:
                nxt[run] = y0
            else:
                rects.append((run[0], y0, run[1], y))
        for run in runs:
            if run not in nxt:
                nxt[run] = y
        open_runs = nxt
    return rects


if __name__ == '__main__':
    import sys
    kind, path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    m = mall_walls(path) if kind == 'mall' else office_walls(path)
    img = Image.open(path).convert('RGB')
    arr = np.asarray(img).copy()
    arr[m] = (20, 60, 200)
    Image.fromarray(arr).save(out)
    f = 2
    d = downsample(m, f)
    print(kind, m.shape, 'cells', int(d.sum()), 'rects', len(greedy_rects(d)))
