// js/connectors/home-assistant.js — thin domain layer over the bridge's HA proxy.
// NO DOM, NO color: pure data + honest availability logic. The widget (home.js)
// and the voice tools read power through here. Nothing in this file ever invents
// data — if HA is unreachable the calls reject and callers degrade honestly.
//
// Availability is derived from two honest signals:
//   1. bridgeClient.online()      — is the local bridge answering /health?
//   2. bridgeClient.features().ha — did that /health report HA_URL+HA_TOKEN set?
// We also cache the last 'bridge:status' feature map as a belt-and-suspenders
// fallback in case a consumer reads before the first getter call resolves.

import { bridgeClient } from '../bridge-client.js';
import { bus } from '../core/event-bus.js';

// Last feature map seen on the bus (fallback for the ha flag).
let lastFeatures = null;
bus.on('bridge:status', ({ features } = {}) => {
  if (features) lastFeatures = features;
});

/** @returns {boolean} whether /health reported HA as configured. */
function haFeatureOn() {
  try {
    const f = bridgeClient.features && bridgeClient.features();
    if (f) return Boolean(f.ha);
  } catch (_e) { /* fall through to bus snapshot */ }
  return Boolean(lastFeatures && lastFeatures.ha);
}

/** @returns {boolean} whether the local bridge is currently answering. */
function bridgeOnline() {
  try { return bridgeClient.online(); } catch (_e) { return false; }
}

/**
 * Collapse a trimmed HA state list into a compact dashboard/voice summary.
 * Counts lights + switches, pulls temperature sensors, and tallies the rest.
 * @param {Array} states
 */
function reduceSummary(states) {
  const list = Array.isArray(states) ? states : [];
  let lightsOn = 0;
  let lightsTotal = 0;
  let switchesOn = 0;
  let switchesTotal = 0;
  let sensors = 0;
  let other = 0;
  const temperatures = [];

  for (const s of list) {
    const id = s && s.entity_id ? String(s.entity_id) : '';
    if (!id) continue;
    const domain = id.includes('.') ? id.slice(0, id.indexOf('.')) : id;
    const attrs = (s && s.attributes) || {};
    const stateStr = String(s.state == null ? '' : s.state).toLowerCase();

    if (domain === 'light') {
      lightsTotal++;
      if (stateStr === 'on') lightsOn++;
    } else if (domain === 'switch') {
      switchesTotal++;
      if (stateStr === 'on') switchesOn++;
    } else if (domain === 'sensor') {
      sensors++;
      const isTemp =
        attrs.device_class === 'temperature' ||
        attrs.unit_of_measurement === '°C' ||
        attrs.unit_of_measurement === '°F';
      if (isTemp) {
        const value = parseFloat(s.state);
        if (Number.isFinite(value)) {
          temperatures.push({
            name: attrs.friendly_name || id,
            value,
            unit: attrs.unit_of_measurement || '°C'
          });
        }
      }
    } else {
      other++;
    }
  }

  return {
    lights: { on: lightsOn, total: lightsTotal },
    switches: { on: switchesOn, total: switchesTotal },
    temperatures,
    sensors,
    other
  };
}

export const ha = {
  /**
   * Is Home Assistant usable right now? True only when the bridge is up AND it
   * reported HA as configured. Never optimistic.
   * @returns {boolean}
   */
  available() {
    return bridgeOnline() && haFeatureOn();
  },

  /**
   * Honest, human PL explanation of why HA is unavailable (empty when it is).
   * @returns {string}
   */
  reason() {
    if (!bridgeOnline()) return 'najpierw uruchom most (localhost:8787)';
    if (!haFeatureOn()) return 'uzupełnij HA_URL i HA_TOKEN w bridge/.env i zrestartuj most';
    return '';
  },

  /**
   * Pull all states and reduce to a compact summary for the model / widget.
   * @returns {Promise<object>} rejects if the bridge/HA is unreachable.
   */
  async summary() {
    const states = await bridgeClient.haStates();
    return reduceSummary(states);
  },

  /**
   * List raw (trimmed) states for a single HA domain, e.g. 'light'.
   * @param {string} domain
   * @returns {Promise<Array>}
   */
  async listByDomain(domain) {
    return bridgeClient.haStates({ domain });
  },

  /**
   * Call an HA service (control power). Domain is caller-derived from entity_id.
   * @param {string} domain
   * @param {string} service
   * @param {object} data  service data, e.g. {entity_id, brightness_pct}
   * @returns {Promise<Array>} HA's changed-states array.
   */
  async callService(domain, service, data) {
    return bridgeClient.haService({ domain, service, data });
  }
};
