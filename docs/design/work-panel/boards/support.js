// A small stand-in for the canvas runtime, so a board renders outside the
// canvas (in a browser, in the headless render that makes the PNGs). Seven
// boards hold a template: `{{path}}` holes filled from `renderVals()`,
// `<sc-for list="{{items}}" as="x">` loops and `<sc-if value="{{flag}}">`
// conditions. Everything else is plain HTML and needs nothing from here.
(function () {
  'use strict';

  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;

  function lookup(scope, expr) {
    const text = expr.trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (/^'.*'$/.test(text) || /^".*"$/.test(text)) return text.slice(1, -1);
    let value = scope;
    for (const part of text.split('.')) {
      if (value === null || value === undefined) return undefined;
      value = value[part];
    }
    return value;
  }

  function fill(text, scope) {
    return text.replace(HOLE, (_, expr) => {
      const value = lookup(scope, expr);
      if (value === undefined || value === null || typeof value === 'function') return '';
      return String(value);
    });
  }

  function render(node, scope, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(fill(node.data, scope)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-for') {
      const list = lookup(scope, (node.getAttribute('list') || '').replace(/[{}]/g, '')) || [];
      const as = node.getAttribute('as') || 'item';
      for (const item of list) {
        const inner = Object.assign(Object.create(scope), { [as]: item });
        for (const child of node.childNodes) render(child, inner, out);
      }
      return;
    }
    if (tag === 'sc-if') {
      const value = lookup(scope, (node.getAttribute('value') || '').replace(/[{}]/g, ''));
      if (value) for (const child of node.childNodes) render(child, scope, out);
      return;
    }
    // Keep the namespace: an <svg> subtree must be SVG, not unknown HTML.
    const el = document.createElementNS(node.namespaceURI, node.localName);
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name)) {
        const handler = lookup(scope, attr.value.replace(/[{}]/g, ''));
        if (typeof handler === 'function') el.addEventListener(attr.name.slice(2).toLowerCase(), handler);
        continue;
      }
      el.setAttribute(attr.name, fill(attr.value, scope));
    }
    for (const child of node.childNodes) render(child, scope, el);
    out.appendChild(el);
  }

  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      Object.assign(this.state, patch);
      if (this._paint) this._paint();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('x-dc');
    const script = document.querySelector('script[type="text/x-dc"]');
    if (!host || !script) return;
    const template = document.createElement('template');
    template.innerHTML = host.innerHTML;
    if (!/\{\{/.test(host.innerHTML) && !template.content.querySelector('sc-for, sc-if')) return;
    let props = {};
    try { props = JSON.parse(script.getAttribute('data-props') || '{}'); } catch (e) { /* keep {} */ }
    let component;
    try {
      const Component = new Function('DCLogic', script.textContent + '\nreturn Component;')(DCLogic);
      component = new Component(props);
    } catch (e) {
      console.error('support.js: could not load the board component', e);
      return;
    }
    const paint = () => {
      const vals = component.renderVals ? component.renderVals() : {};
      const scope = Object.assign(Object.create(null), vals);
      const out = document.createDocumentFragment();
      for (const child of template.content.childNodes) render(child, scope, out);
      host.replaceChildren(out);
    };
    component._paint = paint;
    paint();
  });
})();
