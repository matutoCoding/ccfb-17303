import './styles.css';
import { store } from './state/store';
import { h, clear } from './ui/dom';
import { renderCasesPage } from './pages/cases';
import { renderImportPage } from './pages/import';
import { renderResectionPage } from './pages/resection';
import { renderFibulaPage } from './pages/fibula';
import { renderGuidesPage } from './pages/guides';
import { renderVerifyPage } from './pages/verify';
import { renderSettingsPage } from './pages/settings';

const NAV = [
  { hash: '#/cases', label: '病例列表', idx: '01' },
  { hash: '#/import', label: '模型导入', idx: '02' },
  { hash: '#/resection', label: '切除规划', idx: '03' },
  { hash: '#/fibula', label: '腓骨排布', idx: '04' },
  { hash: '#/guides', label: '导板设计', idx: '05' },
  { hash: '#/verify', label: '校核导出', idx: '06' },
  { hash: '#/settings', label: '设置', idx: '07' },
];

let cleanup: (() => void) | void;

function route(): void {
  const hash = location.hash || '#/cases';
  const active = NAV.find((n) => hash.startsWith(n.hash))?.hash ?? '#/cases';
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.hash === active));
  const content = document.getElementById('content')!;
  clear(content);
  try { cleanup?.(); } catch { /* noop */ }
  cleanup = undefined;
  const map: Record<string, (c: HTMLElement) => (() => void) | void> = {
    '#/cases': renderCasesPage,
    '#/import': renderImportPage,
    '#/resection': renderResectionPage,
    '#/fibula': renderFibulaPage,
    '#/guides': renderGuidesPage,
    '#/verify': renderVerifyPage,
    '#/settings': renderSettingsPage,
  };
  cleanup = (map[active] ?? renderCasesPage)(content);
}

async function bootstrap(): Promise<void> {
  const app = document.getElementById('app')!;
  app.classList.add('app');
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'logo' },
      h('div', { class: 'logo-mark' }, '腓'),
      h('div', {}, h('b', {}, '腓骨瓣导板规划'), h('small', {}, 'Fibula Guide Planner · WebGL2')),
    ),
    ...NAV.map((n) => h('button', {
      class: 'nav-item', dataset: { hash: n.hash },
      onclick: () => { location.hash = n.hash; },
    }, h('span', { class: 'idx' }, n.idx), n.label)),
    h('div', { class: 'side-foot' },
      '数据仅存本机 IndexedDB', h('br'), '锯槽精度目标 ≤0.5° / 0.3mm'),
  );
  const topbar = h('header', { class: 'topbar' },
    h('h1', { id: 'page-title' }, '腓骨瓣重建规划与截骨导板系统'),
    h('div', { class: 'case-switch' }, h('span', { class: 'muted', id: 'case-label' }, '未选择病例')),
    h('div', { class: 'spacer' }),
    h('span', { class: 'badge badge-info' }, 'TypeScript · WebGL2 · GLSL'),
  );
  const content = h('main', { class: 'content', id: 'content' });
  const main = h('div', { class: 'main' }, topbar, content);
  app.append(sidebar, main);

  await store.boot();
  const updateLabel = () => {
    const c = store.currentCase;
    const el = document.getElementById('case-label');
    if (el) el.textContent = c ? `当前病例：${c.name}` : '未选择病例';
  };
  store.subscribe(updateLabel);
  updateLabel();

  window.addEventListener('hashchange', route);
  (window as unknown as { __rerenderRoute?: () => void }).__rerenderRoute = route;
  if (!location.hash) location.hash = '#/cases';
  route();
}

void bootstrap();
