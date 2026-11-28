import * as Motion from './src/index.mjs';
const { default: _default, ...api } = Motion;
const root = globalThis;
root.Motion = api;
root.No996Motion = api;
if (typeof window !== 'undefined' && window !== root) {
  window.Motion = api;
  window.No996Motion = api;
}
