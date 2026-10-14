// ตัวช่วยสร้าง DOM อย่างปลอดภัย: ข้อความทั้งหมดใส่ผ่าน textContent ไม่ใช้ innerHTML กับข้อมูลผู้ใช้

/**
 * h('div.card#x', { onclick, attrs }, children...)
 * props: class, text, on<Event>, aria/data/อื่น ๆ เป็น attribute, style (object)
 */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9]+)((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m ? m[1] : tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/** แทนที่ลูกทั้งหมด โดยพยายามคง focus ไว้ที่องค์ประกอบที่มี data-focus-key เดิม */
export function replaceChildren(container, ...children) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.getAttribute('data-focus-key') : null;
  container.replaceChildren();
  append(container, children);
  if (key) {
    const again = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

export function select(opts, value, props = {}) {
  return h('select', props, opts.map(([v, label]) => h('option', { value: v, selected: v === value, text: label })));
}

export function field(label, control, hint) {
  return h('label.field', h('span.field-label', label), control, hint ? h('span.hint', hint) : null);
}

export function download(filename, text, type = 'application/json') {
  // ในกรอบที่จำกัด (เช่นหน้าแชร์ลิงก์) เบราว์เซอร์บล็อกการดาวน์โหลด — แสดงข้อความให้คัดลอกแทน
  let framed = false;
  try { framed = window.self !== window.top; } catch { framed = true; }
  if (framed) { showCopyDialog(filename, text); return; }
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function showCopyDialog(filename, text) {
  const ta = h('textarea', { readonly: true, rows: 12, 'aria-label': `เนื้อหาไฟล์ ${filename}` });
  ta.value = text.replace(/^\uFEFF/, '');
  const msg = h('p.form-msg', { role: 'status' });
  const close = () => overlay.remove();
  const overlay = h('div.copy-overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `ส่งออก ${filename}`, onkeydown: (e) => { if (e.key === 'Escape') close(); } },
    h('div.copy-dialog',
      h('h3', `ส่งออก ${filename}`),
      h('p.hint', 'หน้านี้เปิดผ่านลิงก์แชร์ซึ่งดาวน์โหลดไฟล์ไม่ได้ — คัดลอกเนื้อหาไปวางในไฟล์ใหม่ชื่อนี้แทน หรือเปิดจากโปรเจกต์บนเครื่องเพื่อดาวน์โหลดตรง'),
      ta,
      h('div.btn-row',
        h('button.btn.primary', {
          type: 'button',
          onclick: async () => {
            try { await navigator.clipboard.writeText(ta.value); msg.textContent = 'คัดลอกแล้ว'; } catch { ta.focus(); ta.select(); msg.textContent = 'คัดลอกอัตโนมัติไม่ได้ — เลือกข้อความแล้วกด Ctrl+C'; }
          },
        }, 'คัดลอกทั้งหมด'),
        h('button.btn', { type: 'button', onclick: close }, 'ปิด')),
      msg));
  document.body.appendChild(overlay);
  overlay.querySelector('button')?.focus();
}

/** ปุ่มยืนยันสองจังหวะ (ใช้แทน confirm() ซึ่งบางกรอบแสดงไม่ได้) */
export function confirmClick(btn, confirmLabel, action) {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.label;
    return action();
  }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = confirmLabel;
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; } }, 5000);
  return undefined;
}

export function fmtNum(v, decimals = 1) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '—');
  return v.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
