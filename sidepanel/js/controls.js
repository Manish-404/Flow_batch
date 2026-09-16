// Small reusable widgets: icon select dropdown and numeric stepper.
import { el } from './utils.js';

function ratioIcon(kind) {
  const dims = { land: [22, 13], port: [12, 20], sq: [17, 17] }[kind];
  if (!dims) return document.createTextNode(kind || '');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '26');
  svg.setAttribute('height', '26');
  svg.setAttribute('viewBox', '0 0 26 26');
  const r = document.createElementNS(ns, 'rect');
  r.setAttribute('x', String((26 - dims[0]) / 2));
  r.setAttribute('y', String((26 - dims[1]) / 2));
  r.setAttribute('width', String(dims[0]));
  r.setAttribute('height', String(dims[1]));
  r.setAttribute('rx', '3');
  r.setAttribute('fill', 'none');
  r.setAttribute('stroke', 'currentColor');
  r.setAttribute('stroke-width', '1.8');
  svg.append(r);
  return svg;
}

export class IconSelect {
  constructor(root, { iconClass = '', onChange }) {
    this.root = root;
    this.iconClass = iconClass;
    this.onChange = onChange;
    this.options = [];
    this.value = null;
    root.classList.add('cselect');
    document.addEventListener('click', (e) => {
      if (!root.contains(e.target)) this.close();
    });
  }

  setOptions(options, value) {
    this.options = options;
    this.value = options.some((o) => o.id === value) ? value : options[1]?.id ?? options[0]?.id;
    this.render();
    return this.value;
  }

  optionButton(o, isTrigger) {
    const icon = el('span', { class: `cselect-icon ${this.iconClass}` });
    icon.append(ratioIcon(o.icon));
    return el(
      'button',
      { class: `cselect-btn${!isTrigger && o.id === this.value ? ' sel' : ''}`, type: 'button' },
      icon,
      el('span', { class: 'cselect-text' }, el('b', { text: o.label }), el('small', { text: o.sub || '' })),
      isTrigger ? el('span', { class: 'cselect-chev', text: '⌄' }) : null
    );
  }

  render() {
    this.root.replaceChildren();
    const current = this.options.find((o) => o.id === this.value) || this.options[0];
    if (!current) return;
    const trigger = this.optionButton(current, true);
    trigger.addEventListener('click', () => (this.root.classList.contains('open') ? this.close() : this.open()));
    this.root.append(trigger);
  }

  open() {
    this.close();
    const menu = el('div', { class: 'cselect-menu' });
    for (const o of this.options) {
      const b = this.optionButton(o, false);
      b.addEventListener('click', () => {
        this.value = o.id;
        this.close();
        this.render();
        this.onChange?.(o.id);
      });
      menu.append(b);
    }
    this.root.append(menu);
    this.root.classList.add('open');
  }

  close() {
    this.root.querySelector('.cselect-menu')?.remove();
    this.root.classList.remove('open');
  }
}

export function makeStepper(root, { value, min, max, step, onChange }) {
  const input = el('input', { type: 'number', min, max, step, value });
  const clamp = (v) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  const set = (v) => {
    const next = clamp(v);
    input.value = next;
    onChange(next);
  };
  root.replaceChildren(
    el('button', { type: 'button', text: '−', onclick: () => set(Number(input.value) - step) }),
    input,
    el('button', { type: 'button', text: '+', onclick: () => set(Number(input.value) + step) })
  );
  input.addEventListener('change', () => set(Number(input.value)));
  return { set: (v) => (input.value = clamp(v)) };
}
