/**
 * Details card for a clicked local-layer feature that carries source notes
 * (`video_summary` / `video_url`, e.g. Chicago Events). The world-overlay card
 * only fits two short lines and cannot hold a link, so this small DOM card
 * shows the full caption-derived summary and a link to the video timestamp.
 * Features without notes never open it.
 */

/** Accept only absolute https URLs; anything else renders no link. */
function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function line(text, style = {}) {
  const element = document.createElement('div');
  element.textContent = text;
  Object.assign(element.style, style);
  return element;
}

export class LocalSelectionCard {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container Element the card is appended to.
   * @param {import('./uiLifetime.js').UiLifetime} options.lifetime Listener owner.
   */
  constructor({ container, lifetime }) {
    this._container = container;
    this._card = null;
    lifetime.listen(window, 'gev:entity-selected', (event) =>
      this._show(event.detail),
    );
    lifetime.listen(window, 'gev:entity-selection-cleared', () => this.hide());
  }

  _show(record) {
    const props = record?.properties;
    if (!props || !(props.video_summary || props.video_url || props.summary)) {
      this.hide();
      return;
    }
    this.hide();
    const card = document.createElement('section');
    card.dataset.localSelectionCard = record.layerId || '';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', `${record.label || 'Feature'} details`);
    Object.assign(card.style, {
      position: 'absolute',
      right: '12px',
      bottom: '84px',
      width: '300px',
      maxHeight: '50vh',
      overflowY: 'auto',
      zIndex: '40',
      color: '#e3faff',
      background: '#08141eed',
      border: '1px solid #7b7b7b',
      padding: '10px 12px',
      font: '12px/1.45 sans-serif',
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close details');
    Object.assign(close.style, {
      float: 'right',
      background: 'none',
      border: 'none',
      color: '#d1d1d1',
      font: '16px sans-serif',
      cursor: 'pointer',
    });
    close.addEventListener('click', () => this.hide());
    card.append(close);

    card.append(
      line(props.name || record.label || '', {
        fontWeight: 'bold',
        fontSize: '13px',
        marginBottom: '4px',
      }),
    );
    if (props.victim) card.append(line(`Victim: ${props.victim}`));
    if (props.victim_gang)
      card.append(line(`Victim's set: ${props.victim_gang}`));
    if (props.alleged_group)
      card.append(line(`Alleged: ${props.alleged_group}`));
    if (props.reliability)
      card.append(
        line(`Reliability: ${props.reliability}`, { opacity: '0.8' }),
      );
    if (record.layerName) {
      card.append(line(record.layerName, { fontSize: '11px', opacity: '0.7' }));
    }
    for (const text of [props.video_summary, props.summary]) {
      if (text) {
        card.append(line(text, { marginTop: '6px', whiteSpace: 'pre-wrap' }));
      }
    }
    if (props.nearest_trauma_center) {
      card.append(
        line(
          `Nearest trauma center: ${props.nearest_trauma_center} (${props.nearest_trauma_level}), ${props.nearest_trauma_miles} mi`,
          { marginTop: '6px' },
        ),
      );
      if (
        props.nearest_level1_center &&
        props.nearest_level1_center !== props.nearest_trauma_center
      ) {
        card.append(
          line(
            `Nearest Level I: ${props.nearest_level1_center}, ${props.nearest_level1_miles} mi`,
          ),
        );
      }
      card.append(
        line('Straight-line distance, not driving distance.', {
          fontSize: '11px',
          opacity: '0.65',
        }),
      );
    }
    const href = safeHttpsUrl(props.video_url);
    if (href) {
      const link = document.createElement('a');
      link.textContent = props.video_time
        ? `▶ Watch at ${props.video_time}`
        : '▶ Watch in video';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      Object.assign(link.style, {
        display: 'inline-block',
        marginTop: '8px',
        color: '#d1d1d1',
      });
      card.append(link);
    }
    const sourceHref = safeHttpsUrl(props.source_url);
    if (sourceHref) {
      const link = document.createElement('a');
      link.textContent = 'Open source record ↗';
      link.href = sourceHref;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      Object.assign(link.style, {
        display: 'block',
        marginTop: '8px',
        color: '#c9c9c9',
      });
      card.append(link);
    }
    if (props.video_caveat) {
      card.append(
        line(props.video_caveat, {
          marginTop: '6px',
          fontSize: '11px',
          opacity: '0.65',
        }),
      );
    }
    if (props.source_note) {
      card.append(
        line(`Source: ${props.source_note}`, {
          marginTop: '6px',
          fontSize: '11px',
          opacity: '0.65',
        }),
      );
    }
    if (props.coordinate_note) {
      card.append(
        line(`Location: ${props.coordinate_note}`, {
          fontSize: '11px',
          opacity: '0.65',
        }),
      );
    }
    this._container.append(card);
    this._card = card;
  }

  hide() {
    this._card?.remove();
    this._card = null;
  }

  destroy() {
    this.hide();
  }
}
