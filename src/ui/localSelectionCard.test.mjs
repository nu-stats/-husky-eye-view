// The details card opens for a selected local feature with source notes and
// shows the caption summary plus a safe link to the video timestamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSelectionCard } from './localSelectionCard.js';
import { UiLifetime } from './uiLifetime.js';

/** Just enough DOM for the card: elements with children, text and attributes. */
function fakeElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    textContent: '',
    parent: null,
    listeners: {},
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((n) => n !== this);
      this.parent = null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
  };
}

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

function setup() {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const handlers = {};
  globalThis.document = { createElement: fakeElement };
  globalThis.window = {
    addEventListener: (type, fn) => (handlers[type] = fn),
    removeEventListener: (type) => delete handlers[type],
  };
  const container = fakeElement('div');
  const lifetime = new UiLifetime();
  const card = new LocalSelectionCard({ container, lifetime });
  return {
    container,
    select: (detail) => handlers['gev:entity-selected']({ detail }),
    clear: () => handlers['gev:entity-selection-cleared']({ detail: {} }),
    nodes: () => walk(container).slice(1),
    cleanup() {
      card.destroy();
      lifetime.destroy();
      globalThis.document = originalDocument;
      globalThis.window = originalWindow;
    },
  };
}

const RECORD = {
  id: 'local-chicago-events:chicago-event-3',
  layerId: 'local-chicago-events',
  label: '55th Street & King Drive, Chicago',
  properties: {
    name: '55th Street & King Drive, Chicago',
    victim: '"Gotti" (Michael Lee, 23)',
    video_summary: 'Summary from the captions.',
    video_time: '12:28',
    video_url: 'https://www.youtube.com/watch?v=q4uyyph017M&t=748s',
    video_caveat: 'Unverified street claims.',
  },
};

test('a selected event with notes shows its summary and a timestamp link', () => {
  const env = setup();
  try {
    env.select(RECORD);
    const nodes = env.nodes();
    const text = nodes.map((n) => n.textContent).join('\n');
    assert.match(text, /Summary from the captions\./);
    assert.match(text, /Victim: "Gotti"/);
    const link = nodes.find((n) => n.tagName === 'A');
    assert.ok(link, 'the video link is rendered');
    assert.equal(link.href, RECORD.properties.video_url);
    assert.equal(link.textContent, '▶ Watch at 12:28');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  } finally {
    env.cleanup();
  }
});

test('non-https links are dropped and features without notes open nothing', () => {
  const env = setup();
  try {
    env.select({
      ...RECORD,
      properties: { ...RECORD.properties, video_url: 'javascript:alert(1)' },
    });
    assert.equal(
      env.nodes().some((n) => n.tagName === 'A'),
      false,
    );
    env.select({
      id: 'x',
      layerId: 'local-gang-map',
      properties: { name: 'Hood' },
    });
    assert.equal(env.container.children.length, 0);
  } finally {
    env.cleanup();
  }
});

test('a shooting shows its nearest trauma center and the nearest Level I', () => {
  const env = setup();
  try {
    env.select({
      id: 'local-famous-shootings:1',
      layerId: 'local-famous-shootings',
      layerName: 'Famous Shootings',
      properties: {
        name: 'Gary shooting',
        summary: '06-28-2024 · Shot & killed.',
        nearest_trauma_center: 'Methodist Hospitals Inc',
        nearest_trauma_level: 'Level III',
        nearest_trauma_miles: 0.72,
        nearest_level1_center: 'The University Of Chicago Medical Center',
        nearest_level1_miles: 18.94,
      },
    });
    const text = env
      .nodes()
      .map((n) => n.textContent)
      .join('\n');
    assert.match(
      text,
      /Nearest trauma center: Methodist Hospitals Inc \(Level III\), 0\.72 mi/,
    );
    assert.match(
      text,
      /Nearest Level I: The University Of Chicago Medical Center, 18\.94 mi/,
    );
    assert.match(text, /Straight-line distance/);
  } finally {
    env.cleanup();
  }
});

test('an incident with a source_url links to its source record (https only)', () => {
  const env = setup();
  try {
    env.select({
      id: 'local-gva-2015:gva-376457-0',
      layerId: 'local-gva-2015',
      layerName: 'Gun Deaths 2015 (GVA)',
      properties: {
        name: 'Leon Wiggins Road, Andalusia',
        summary: 'Jul 16, 2015: 1 killed.',
        source_url: 'https://www.gunviolencearchive.org/incident/376457',
      },
    });
    const link = env.nodes().find((n) => n.tagName === 'A');
    assert.equal(link.textContent, 'Open source record ↗');
    assert.equal(
      link.href,
      'https://www.gunviolencearchive.org/incident/376457',
    );
    assert.equal(link.rel, 'noopener noreferrer');
    env.select({
      id: 'local-gva-2015:x',
      layerId: 'local-gva-2015',
      properties: { name: 'x', summary: 'y', source_url: 'http://example.com' },
    });
    assert.equal(
      env.nodes().some((n) => n.tagName === 'A'),
      false,
    );
  } finally {
    env.cleanup();
  }
});

test('an area with a summary (HOLC / life expectancy) opens the card', () => {
  const env = setup();
  try {
    env.select({
      id: 'local-life-expectancy:tract-17031010100',
      layerId: 'local-life-expectancy',
      layerName: 'Life Expectancy (tracts)',
      properties: {
        name: 'Census Tract 101, Cook County, IL',
        summary: 'Life expectancy at birth: 68.8 years.',
        source_note: 'USALEEP census-tract life expectancy (life_exp_8).',
      },
    });
    const text = env
      .nodes()
      .map((n) => n.textContent)
      .join('\n');
    assert.match(text, /Census Tract 101/);
    assert.match(text, /Life Expectancy \(tracts\)/);
    assert.match(text, /68\.8 years/);
    assert.match(text, /Source: USALEEP/);
    assert.equal(
      env.nodes().some((n) => n.tagName === 'A'),
      false,
    );
  } finally {
    env.cleanup();
  }
});

test('the card closes on selection clear and on its close button', () => {
  const env = setup();
  try {
    env.select(RECORD);
    assert.equal(env.container.children.length, 1);
    env.clear();
    assert.equal(env.container.children.length, 0);
    env.select(RECORD);
    const close = env.nodes().find((n) => n.tagName === 'BUTTON');
    close.listeners.click();
    assert.equal(env.container.children.length, 0);
  } finally {
    env.cleanup();
  }
});
