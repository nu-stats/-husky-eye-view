import { readStylesheet } from './testSupport/readStylesheet.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  shouldExpandGlobalContextPanel,
  shouldHideCollapsedRightPanels,
} from './rightRailPolicy.js';

test('Tactical HUD hides collapsed right-rail siblings while one panel is expanded', () => {
  assert.equal(
    shouldHideCollapsedRightPanels({
      hudVariant: 'tactical',
      hasExpandedPanel: true,
    }),
    true,
  );
});

test('collapsed launchers remain when Tactical has no expanded panel', () => {
  assert.equal(
    shouldHideCollapsedRightPanels({
      hudVariant: 'tactical',
      hasExpandedPanel: false,
    }),
    false,
  );
});

test('other HUD layouts keep collapsed right-rail launchers visible', () => {
  assert.equal(
    shouldHideCollapsedRightPanels({
      hudVariant: 'minimal',
      hasExpandedPanel: true,
    }),
    false,
  );
  assert.equal(
    shouldHideCollapsedRightPanels({
      hudVariant: 'full',
      hasExpandedPanel: true,
    }),
    false,
  );
});

test('the bottom panel row keeps every launcher visible, on desktop and mobile', () => {
  // Display, CCTV and Context sit side by side along the bottom edge, so an
  // open panel never needs its siblings hidden: the layout pass clears the
  // exclusive class and any aria-hidden an older stacked layout left behind.
  const ui = readFileSync(
    new URL('./ui/rightPanelRail.js', import.meta.url),
    'utf8',
  );
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  assert.match(
    ui,
    /const isMobile = windowRef\.matchMedia\('\(max-width: 720px\)'\)\.matches/,
  );
  assert.match(ui, /stack\.classList\.remove\('layout-exclusive'/);
  assert.match(ui, /panel\.removeAttribute\('aria-hidden'\)/);
  assert.doesNotMatch(ui, /setAttribute\('aria-hidden', 'true'\)/);
  assert.match(css, /#right-context-rail \{[^}]*flex-direction: row;/);
});

test('bottom rows give every launcher a fixed slot and open panels as pop-ups', () => {
  // Opening one menu must not move the row or its neighbours: each panel is
  // placed absolutely at its own slot, and an open one pops up over it.
  const css = readStylesheet(new URL('../style.css', import.meta.url));
  for (const row of ['#right-context-rail', '#left-panel-stack']) {
    assert.match(
      css,
      new RegExp(
        `${row}\\.bottom-row\\s*>\\s*\\[data-panel-id\\]:is\\([^)]*\\)[^{]*\\{[^}]*position: absolute;[^}]*bottom: 0;[^}]*left: var\\(--slot-left, 0px\\);`,
      ),
      `${row} launchers sit at fixed slots`,
    );
  }
  assert.match(
    css,
    /left: calc\(var\(--slot-left, 0px\) \+ var\(--popup-shift, 0px\)\);/,
  );
});

test('explicit Contacts, Space Missions, and Cockpit actions expand Global Context after success', () => {
  for (const action of ['contacts', 'space-missions', 'cockpit']) {
    assert.equal(
      shouldExpandGlobalContextPanel({
        action,
        explicitUserAction: true,
        succeeded: true,
      }),
      true,
      `${action} should reveal its supporting context`,
    );
  }
});

test('Cockpit expansion is independent of whether a track was already selected', () => {
  for (const selectedTrack of [null, 'UAL649']) {
    assert.equal(
      shouldExpandGlobalContextPanel({
        action: 'cockpit',
        explicitUserAction: true,
        succeeded: true,
        selectedTrack,
      }),
      true,
    );
  }
});

test('restoration and programmatic replay preserve the saved Global Context collapse state', () => {
  assert.equal(
    shouldExpandGlobalContextPanel({
      action: 'contacts',
      explicitUserAction: false,
      succeeded: true,
    }),
    false,
  );
  assert.equal(
    shouldExpandGlobalContextPanel({
      action: 'space-missions',
      explicitUserAction: true,
      succeeded: true,
      restoring: true,
    }),
    false,
  );
});

test('failed or unrelated actions never expand Global Context', () => {
  assert.equal(
    shouldExpandGlobalContextPanel({
      action: 'contacts',
      explicitUserAction: true,
      succeeded: false,
    }),
    false,
    'a failed transition must preserve the prior panel state for rollback',
  );
  assert.equal(
    shouldExpandGlobalContextPanel({
      action: 'search-nearby',
      explicitUserAction: true,
      succeeded: true,
    }),
    false,
  );
});
