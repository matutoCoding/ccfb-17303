// 极简 hyperscript 与常用控件，避免引入框架。
export type ElChild = Node | string | number | false | null | undefined | ElChild[];

export type HProps<K extends keyof HTMLElementTagNameMap> =
  & Partial<Omit<HTMLElementTagNameMap[K], 'style'>>
  & {
    class?: string;
    style?: string | Partial<CSSStyleDeclaration>;
    dataset?: Record<string, string>;
    html?: string;
  };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: HProps<K> | null,
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else Object.assign(el.style, v);
      } else if (k === 'dataset') for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: HTMLElement, children: ElChild[]): void {
  for (const ch of children.flat()) {
    if (ch === false || ch === null || ch === undefined) continue;
    el.append(ch instanceof Node ? ch : document.createTextNode(String(ch)));
  }
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function btn(label: string, onClick: (e: MouseEvent) => void, opts: { primary?: boolean; danger?: boolean; small?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return h('button', {
    class: `btn ${opts.primary ? 'btn-primary' : ''} ${opts.danger ? 'btn-danger' : ''} ${opts.small ? 'btn-sm' : ''}`,
    disabled: opts.disabled,
    title: opts.title,
    onclick: onClick,
  }, label);
}

export function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' = 'muted'): HTMLSpanElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}

export function field(labelText: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, labelText),
    input,
    hint ? h('span', { class: 'field-hint' }, hint) : null,
  );
}

export function numInput(value: number, step: number, onCommit: (v: number) => void, opts: { min?: number; max?: number; unit?: string } = {}): HTMLInputElement {
  const inp = h('input', { type: 'number', class: 'input num', value: String(value), step: String(step), min: opts.min !== undefined ? String(opts.min) : undefined, max: opts.max !== undefined ? String(opts.max) : undefined }) as HTMLInputElement;
  const commit = () => {
    const v = parseFloat(inp.value);
    if (isFinite(v)) onCommit(v);
  };
  inp.addEventListener('change', commit);
  return inp;
}

export function selectInput(options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const o of options) {
    const op = h('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) op.selected = true;
    sel.append(op);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function panel(title: string, ...body: ElChild[]): HTMLElement {
  return h('section', { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h3', {}, title)),
    h('div', { class: 'panel-body' }, ...body),
  );
}

export function table(headers: string[], rows: HTMLElement[][]): HTMLTableElement {
  const thead = h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', {}, x))));
  const tbody = h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))));
  return h('table', { class: 'table' }, thead, tbody);
}

let toastHost: HTMLDivElement | null = null;
export function toast(msg: string, tone: 'ok' | 'err' | 'info' = 'info', ms = 3200): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' }) as HTMLDivElement;
    document.body.append(toastHost);
  }
  const item = h('div', { class: `toast toast-${tone}` }, msg);
  toastHost.append(item);
  setTimeout(() => { item.classList.add('show'); }, 10);
  setTimeout(() => { item.classList.remove('show'); setTimeout(() => item.remove(), 300); }, ms);
}

export function modal(title: string, content: HTMLElement, actions?: HTMLElement[]): { close: () => void; root: HTMLElement } {
  const root = h('div', { class: 'modal-backdrop' });
  const close = () => root.remove();
  const dlg = h('div', { class: 'modal', role: 'dialog' },
    h('header', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'modal-x btn btn-sm', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, content),
    actions ? h('footer', { class: 'modal-foot' }, ...actions) : null,
  );
  root.append(dlg);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.body.append(root);
  return { close, root };
}

export function downloadBlob(data: ArrayBuffer | Blob, filename: string): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
