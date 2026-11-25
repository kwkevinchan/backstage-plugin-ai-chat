import '@testing-library/jest-dom';

// The viewport of assistant-ui measures its content with ResizeObserver and
// scrolls with scrollTo, which jsdom does not have. Nothing is laid out in
// jsdom, so these do nothing.
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  Object.assign(globalThis, { ResizeObserver: NoResizeObserver });
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
