/**
 * Display, CCTV and Context live in one row at the bottom of the screen and
 * open upward, so they stay out of the view. The row sits right beside the
 * command dock (next to Visual Presets), bottom-aligned with it. When the
 * window is too narrow for that, it moves to the bottom-right corner, clear of
 * anything beneath it (the Power Up chip, or the dock itself). Each pass also
 * decides how tall an open panel may grow above the row.
 */

/** Lowest the row sits: level with the Power Up chip's own 0.9rem inset. */
const BOTTOM_ROW_MIN_OFFSET_PX = 14;
/** Room kept free above an open panel, as a fraction of the window height. */
const BOTTOM_ROW_TOP_RESERVE = 0.14;

function hiddenByAncestor(element, getComputedStyle) {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    )
      return true;
  }
  return false;
}

function setIfChanged(element, name, value) {
  if (element.style.getPropertyValue(name) !== value)
    element.style.setProperty(name, value);
}

/**
 * Measure and place the bottom panel row for one synchronous layout pass.
 * The caller owns scheduling, obstacle selection and persistence.
 * @param {object} options Live DOM and caller policy.
 * @param {HTMLElement} options.stack Rail element.
 * @param {HTMLElement} [options.dock] Command dock the row sits beside.
 * @param {Iterable<HTMLElement>} options.obstacles Caller-selected obstacle nodes.
 * @param {Window} options.windowRef Viewport and style reader.
 * @param {Function} options.onCollapse Update a panel's disclosure chrome.
 * @param {HTMLElement} options.displayPanel Panel whose scroll is restored.
 * @param {Function} options.readDisplayScrollTop Read the caller's scroll restoration value.
 * @param {Function} [options.getComputedStyle] Optional DOM style reader override.
 */
export function layoutRightPanelRail({
  stack,
  dock = null,
  obstacles = [],
  windowRef,
  onCollapse = () => {},
  displayPanel,
  readDisplayScrollTop = () => 0,
  getComputedStyle = (element) => windowRef.getComputedStyle(element),
}) {
  if (!stack) return;

  const panels = [...stack.children].filter((panel) =>
    panel.matches('[data-panel-id]'),
  );
  // Side by side, panels never compete for height, so none is collapsed to
  // make room and every launcher stays in reach. Release anything an older
  // stacked layout collapsed or hid.
  for (const panel of panels) {
    if (panel.classList.contains('layout-auto-collapsed')) {
      panel.classList.remove('collapsed', 'layout-auto-collapsed');
      onCollapse(panel);
    }
    panel.removeAttribute('aria-hidden');
    if (panel.style.getPropertyValue('--right-panel-allocated-height'))
      panel.style.removeProperty('--right-panel-allocated-height');
  }
  stack.classList.remove('layout-exclusive');

  const isMobile = windowRef.matchMedia('(max-width: 720px)').matches;
  if (isMobile) {
    stack.classList.remove('layout-focus');
    stack.style.removeProperty('--right-stack-safe-top');
    stack.style.removeProperty('--right-stack-max-height');
    stack.style.removeProperty('--bottom-rail-offset');
    stack.style.removeProperty('--bottom-rail-left');
    stack.style.removeProperty('--bottom-rail-right');
    stack.dataset.layoutMode = 'mobile';
    return;
  }
  stack.classList.remove('layout-focus');

  const viewportHeight = Math.max(1, windowRef.innerHeight);
  const viewportWidth = Math.max(1, windowRef.innerWidth || 0);
  const gap = Math.max(8, viewportHeight * 0.012);
  const rail = stack.getBoundingClientRect();
  const rects = [];
  for (const obstacle of obstacles) {
    if (obstacle === dock || stack.contains(obstacle)) continue;
    const rect = obstacle.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (hiddenByAncestor(obstacle, getComputedStyle)) continue;
    rects.push(rect);
  }

  // Beside the dock whenever the row fits between it and the window edge,
  // bottom-aligned with it; anything low beneath the row there (the Power Up
  // chip) lifts the row just enough to clear it.
  let placement = null;
  const dockRect =
    dock && !hiddenByAncestor(dock, getComputedStyle)
      ? dock.getBoundingClientRect()
      : null;
  if (dockRect && dockRect.width > 0 && dockRect.height > 0) {
    const left = dockRect.right + gap;
    const right = left + rail.width;
    if (right <= viewportWidth - BOTTOM_ROW_MIN_OFFSET_PX) {
      let offset = Math.max(0, viewportHeight - dockRect.bottom);
      for (const rect of rects) {
        if (rect.right <= left || rect.left >= right) continue;
        if (rect.top < viewportHeight * 0.5) continue;
        offset = Math.max(offset, viewportHeight - rect.top + gap);
      }
      placement = { mode: 'docked', left, offset };
    }
  }
  if (!placement) {
    // Bottom-right corner, above anything beneath the row there.
    const railLeft = viewportWidth - BOTTOM_ROW_MIN_OFFSET_PX - rail.width;
    let offset = BOTTOM_ROW_MIN_OFFSET_PX;
    for (const rect of [...rects, ...(dockRect ? [dockRect] : [])]) {
      if (rect.right <= railLeft || rect.top < viewportHeight * 0.5) continue;
      offset = Math.max(offset, viewportHeight - rect.top + gap);
    }
    placement = { mode: 'corner', left: null, offset };
  }
  const { offset } = placement;
  const topReserve = Math.max(96, viewportHeight * BOTTOM_ROW_TOP_RESERVE);
  const maxHeight = Math.max(160, viewportHeight - offset - topReserve);
  setIfChanged(stack, '--bottom-rail-offset', `${offset.toFixed(1)}px`);
  setIfChanged(
    stack,
    '--bottom-rail-left',
    placement.left == null ? 'auto' : `${placement.left.toFixed(1)}px`,
  );
  setIfChanged(
    stack,
    '--bottom-rail-right',
    placement.left == null ? `${BOTTOM_ROW_MIN_OFFSET_PX}px` : 'auto',
  );
  setIfChanged(stack, '--right-stack-max-height', `${maxHeight.toFixed(1)}px`);
  if (stack.style.getPropertyValue('--right-stack-safe-top'))
    stack.style.removeProperty('--right-stack-safe-top');
  stack.dataset.layoutMode = 'bottom';
  stack.dataset.placement = placement.mode;
  stack.dataset.bottomOffset = offset.toFixed(1);
  stack.dataset.availableHeight = maxHeight.toFixed(1);

  if (displayPanel && !displayPanel.classList.contains('collapsed')) {
    const displayScrollTop = readDisplayScrollTop();
    const maxScrollTop = Math.max(
      0,
      displayPanel.scrollHeight - displayPanel.clientHeight,
    );
    displayPanel.scrollTop = Math.min(displayScrollTop, maxScrollTop);
  }
}
