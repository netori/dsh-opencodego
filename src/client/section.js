/**
 * The settings section itself: React, no JSX, no imports beyond `react` and
 * this plugin's own modules.
 *
 * The browser bundle is built by `scripts/build-client.mjs`, which appends the
 * `window.__ModuleLoader__.load({ id, factory })` wrapper and selects the
 * externals from `package.json` — so this file only ever contains the code
 * between the factory braces. `react` is a platform seed word the shell provides
 * (see `scripts/build-client.mjs`); every other import here is relative and
 * gets inlined.
 *
 * Every rule this file applies lives in `./logic.js`, which is tested without a
 * DOM. Nothing here formats a rejection, invents a default, or decides what a
 * save writes.
 *
 * The model surface speaks TWO verbs and no data-layer vocabulary, and it is
 * built on exactly TWO model sources — the gateway's `/models` list (which
 * models exist) and the plugin's own saved model state (what dsh loads for
 * each):
 *
 *   - "获取可用模型" asks the gateway for its full list and shows it as a PLAIN
 *     LIST: id and name only, no capability chips. The list answers a
 *     membership question — which ids exist — and that answer must not depend
 *     on the plugin having an opinion about what each id can do. Capability
 *     facts are established separately, from evidence, and never guessed here.
 *     The checkboxes mirror what is enabled NOW; "应用选择" commits the whole
 *     selection to settings immediately. Picking IS activating.
 *   - "添加模型" registers one id the list does not show, and activates it on
 *     the spot.
 *
 * Removing a model (the row's trash icon) commits too. What the page never
 * shows: the words 目录/端点/手写/已排除/冻结/已自定义, the `replaceDiscovered`
 * switch, or any per-row badge claiming a row is "customized" — those are
 * storage mechanics, not operator decisions, and a badge on every row is noise
 * that tells the operator nothing they cannot see by expanding the row.
 * Expanding a row still edits per-model overrides, and those edits auto-save
 * like everything else on this page: a change IS the commit.
 *
 * The visual language is the official settings page's (the Models section of
 * `@deepseek-ai/dsh-client-ui-settings-models`): the same alias tokens, the same
 * radii and button geometry (36px pills, 28px row pills, 28px icon buttons,
 * 16px cards over a 12px module panel), the same chevron-`details` collapse for
 * advanced settings. One stylesheet, injected as a fiber-scoped <style> element,
 * because the loader serves no plugin CSS.
 *
 * @module dsh-opencodego/client/section
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  activateSubscription,
  activationWriteOps,
  addModelById,
  addSubscriptionRow,
  balanceCells,
  capabilityChips,
  catalogueView,
  capacityPlaceholder,
  deepEqual,
  describeFailure,
  describeSync,
  defaultRowHidden,
  diagnosticsView,
  directoryRows,
  errorPathsOf,
  modelSourceLine,
  officialSourceText,
  formFromView,
  isConflictFailure,
  isDirty,
  isModelEnabled,
  legacyApiKeyPresent,
  modalityPlaceholder,
  modelsWriteOps,
  patchDirectoryRow,
  removeDirectoryRow,
  patchSubRow,
  removeSubRow,
  replacementSuggestions,
  restoreDefaultRow,
  subsBlockFrom,
  subscriptionSlots,
  resetPhrase,
  resetShort,
  resetStamp,
  revisionFor,
  setModelSelection,
  stagedCredentialPlanFor,
  usageView,
  syncProgressText,
  syncTargetIds,
  unwrapPayload,
  validateForm,
  writeOps,
} from './logic.js'
import {
  ADD_MODEL_BUTTON,
  ADD_MODEL_HINT,
  ADD_MODEL_LABEL,
  CONFIGURABLE_INPUT_MODALITIES,
  CONFIGURABLE_THINKING_LEVELS,
  DEFAULT_SUB_ID,
  DEFAULT_SUB_LABEL,
  FETCH_APPLY,
  FETCH_DESCRIPTION,
  FETCH_DESELECT_ALL,
  FETCH_EMPTY,
  FETCH_NO_MATCHES,
  FETCH_SEARCH,
  FETCH_SELECT_ALL,
  FETCH_TITLE,
  LEGACY_API_KEY_WARNING,
  SESSION_HEADER_HINT,
  SETTINGS_NS,
  SUBS_ACTIVATE_HINT,
  SUBS_ACTIVE_BADGE,
  SUBS_ADD_BUTTON,
  SUBS_ADD_HINT,
  SUBS_DESCRIPTION,
  SUBS_KEY_LABEL,
  SUBS_KEY_MISSING,
  SUBS_KEY_PLACEHOLDER,
  SUBS_KEY_SLOT,
  SUBS_KEY_STORED,
  SUBS_KEY_UNKNOWN,
  SUBS_KEY_UNKNOWN_HINT,
  SUBS_NAME_LABEL,
  SUBS_NAME_PLACEHOLDER,
  SUBS_NEVER_PROBED,
  SUBS_NOTE,
  SUBS_REFRESH_BUTTON,
  SUBS_REFRESH_BUSY,
  SUBS_RESTORE_DEFAULT,
  SUBS_ROW_EDIT,
  SUBS_ROW_LOCKED,
  SUBS_ROW_REMOVE,
  SUBS_TITLE,
  SYNC_BUTTON,
  SYNC_BUSY,
  SYNC_HINT,
  SYNC_NOTE,
  SYNC_NOT_SYNCED,
  SYNC_STOP,
  SESSION_HEADER_MODES,
  SUPPORTED_PROTOCOLS,
  USAGE_WINDOW_KEYS,
  USAGE_WINDOW_LABELS,
  USAGE_WINDOW_SHORT,
} from './vocab.js'

/**
 * One stylesheet, injected as a fiber-scoped <style> element: the loader serves
 * no plugin CSS. Every value here is lifted from the official settings Models
 * section (`ModelsSection.module.css` of `dsh-client-ui-settings-models`) so the
 * page reads as part of the shell instead of beside it.
 */
const SECTION_CSS = `
.ocg-section { max-width: 720px; color: var(--dsw-alias-label-primary); flex-direction: column; gap: 12px; display: flex; }
.ocg-title { color: var(--dsw-alias-label-primary); margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.ocg-intro { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 14px; line-height: 22px; }
.ocg-notice { margin: 0; font-size: 12px; line-height: 18px; white-space: pre-wrap; word-break: break-word; }
.ocg-notice--ok { color: var(--dsw-alias-state-success-primary); }
.ocg-notice--warn { color: var(--dsw-alias-state-warn-label); }
.ocg-notice--error { color: var(--dsw-alias-state-error-primary); }
.ocg-card { border: .5px solid var(--dsw-alias-border-l4); border-radius: 16px; flex-direction: column; gap: 12px; padding: 12px 14px; display: flex; }
.ocg-card-head { align-items: center; gap: 10px; display: flex; }
.ocg-identity { align-items: center; gap: 6px; min-width: 0; display: inline-flex; }
.ocg-name { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }
.ocg-dot { box-sizing: border-box; border-radius: 50%; flex: none; width: 8px; height: 8px; display: inline-block; }
.ocg-dot--ok { background: var(--dsw-alias-state-success-primary); }
.ocg-dot--warn { background: var(--dsw-alias-state-warning-primary); }
.ocg-dot--bad { background: var(--dsw-alias-state-error-primary); }
.ocg-dot--dim { background: var(--dsw-alias-label-dimmed); }
.ocg-head-actions { align-items: center; gap: 4px; margin-left: auto; display: inline-flex; }
.ocg-btn {
  box-sizing: border-box; height: 36px; font: inherit; cursor: pointer; border: none; border-radius: 18px;
  justify-content: center; align-items: center; gap: 4px; padding: 0 14px; font-size: 14px; line-height: 22px; display: inline-flex;
}
.ocg-btn--primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.ocg-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ocg-btn--secondary { border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); background: 0 0; }
.ocg-btn--secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.ocg-btn:disabled { opacity: .4; cursor: default; }
.ocg-head-actions .ocg-btn { border-radius: 14px; height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px; }
.ocg-btn:focus-visible, .ocg-link:focus-visible, .ocg-icon:focus-visible,
.ocg-details-summary:focus-visible, .ocg-chip-btn:focus-visible, .ocg-add-btn:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); outline: none;
}
.ocg-editor { background: var(--dsw-alias-bg-module-platform); border-radius: 12px; flex-direction: column; gap: 14px; padding: 14px 16px; display: flex; }
.ocg-field { flex-direction: column; gap: 6px; display: flex; }
.ocg-field-label { color: var(--dsw-alias-label-secondary); align-items: center; gap: 10px; font-size: 12px; font-weight: 500; line-height: 18px; display: inline-flex; }
.ocg-link {
  box-sizing: border-box; height: 28px; color: var(--dsw-alias-label-tertiary); font: inherit; cursor: pointer;
  background: 0 0; border: none; border-radius: 14px; align-items: center; padding: 0 10px; font-size: 12px; line-height: 18px; display: inline-flex;
}
.ocg-link:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.ocg-link:disabled { opacity: .4; cursor: default; }
.ocg-link--danger { color: var(--dsw-alias-state-error-primary); }
.ocg-link--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.ocg-hint { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; }
.ocg-error { color: var(--dsw-alias-state-error-primary); margin: 0; font-size: 12px; line-height: 18px; }
.ocg-details { border-top: .5px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.ocg-details-summary {
  cursor: pointer; width: fit-content; color: var(--dsw-alias-label-secondary); border-radius: 6px; align-items: center;
  gap: 6px; margin-left: -4px; padding: 2px 4px; font-size: 12px; font-weight: 500; line-height: 18px; list-style: none; display: flex;
}
.ocg-details-summary::-webkit-details-marker { display: none; }
.ocg-details-summary:before {
  content: ""; border-bottom: 1.5px solid; border-right: 1.5px solid; width: 5px; height: 5px;
  transition: transform .12s; transform: rotate(-45deg) translate(-1px, -1px);
}
.ocg-details[open] > .ocg-details-summary:before { transform: rotate(45deg) translate(-1px, -1px); }
.ocg-details-summary:hover { color: var(--dsw-alias-label-primary); }
.ocg-details-body { flex-direction: column; gap: 12px; padding-top: 12px; display: flex; }
.ocg-catalog { border-top: .5px solid var(--dsw-alias-border-l2); flex-direction: column; gap: 10px; padding-top: 12px; display: flex; }
.ocg-catalog-head { justify-content: space-between; align-items: flex-start; gap: 12px; display: flex; }
.ocg-catalog-heading { flex-direction: column; gap: 2px; display: flex; }
.ocg-catalog-title { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.ocg-catalog-meta { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; }
.ocg-catalog-actions { align-items: center; gap: 4px; flex-wrap: wrap; justify-content: flex-end; display: inline-flex; }
.ocg-model-list { flex-direction: column; gap: 8px; display: flex; }
.ocg-model-entry { border: .5px solid var(--dsw-alias-border-l4); border-radius: 10px; padding: 6px; }
.ocg-model-row { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto; align-items: center; gap: 6px; display: grid; }
.ocg-model-name-cell { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; }
.ocg-model-id-cell { color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, monospace); font-size: 12px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 4px; }
.ocg-icon {
  box-sizing: border-box; width: 28px; height: 28px; color: var(--dsw-alias-label-tertiary); cursor: pointer;
  background: 0 0; border: none; border-radius: 6px; justify-content: center; align-items: center; display: inline-flex;
}
.ocg-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ocg-icon:disabled { cursor: default; opacity: .4; }
.ocg-icon--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.ocg-chips { flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 4px 2px; display: flex; }
.ocg-chip { border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); border-radius: 4px; flex: none; padding: 1px 6px; font-size: 11px; line-height: 16px; }
.ocg-chip[data-tone="proto"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l4); font-weight: 500; }
.ocg-chip[data-tone="dim"] { color: var(--dsw-alias-label-dimmed); }
.ocg-chip[data-tone="warn"] { color: var(--dsw-alias-state-warning-primary); border-color: var(--dsw-alias-state-warning-primary); }
.ocg-chip[data-tone="bad"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); font-weight: 500; }

/* ── the subscription list (0.8.2) ───────────────────────────────────────────
   The top of the page: one clickable row per key, three balance meters, and a
   collapsed editor. The row is ONE line so the list reads as a list; everything
   that explains instead of deciding lives in a title tooltip. */
.ocg-subs { flex-direction: column; gap: 10px; display: flex; }
.ocg-subs-head { align-items: center; gap: 8px; flex-wrap: wrap; display: flex; }
.ocg-subs-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 20px; }
.ocg-subs-count {
  color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
  border-radius: 999px; flex: none; padding: 0 7px; font-size: 11px; line-height: 16px;
}
.ocg-subs-note { color: var(--dsw-alias-label-tertiary); margin-right: auto; font-size: 12px; line-height: 18px; }
.ocg-subs-actions { align-items: center; gap: 6px; flex: none; margin-left: auto; display: inline-flex; }
.ocg-subs-list { flex-direction: column; gap: 8px; display: flex; }
.ocg-btn--compact { height: 26px; border-radius: 13px; padding: 0 10px; font-size: 12px; line-height: 18px; }

.ocg-sub {
  border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; position: relative; overflow: hidden;
  transition: border-color .12s, background .12s;
}
.ocg-sub:hover { border-color: var(--dsw-alias-border-l3); }
.ocg-sub--active { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }
.ocg-sub--active:before {
  content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px;
  border-radius: 0 2px 2px 0; background: var(--dsw-alias-brand-primary);
}
.ocg-sub-main {
  /* Two lines: [radio | name + badge | 设置 | 删除] then the balance under the
     name. The name column is the only flexible one — it takes every pixel the
     actions leave, so a long address is squeezed only when it genuinely must be.
     The balance line starts at column 2 and runs to the end of the row, which is
     what gives the three meters (and the reset phrase under each) their room. */
  grid-template-columns: auto minmax(0, 1fr) auto auto; row-gap: 6px; align-items: center; column-gap: 8px;
  cursor: pointer; padding: 8px 6px 9px 12px; display: grid; min-width: 0;
}
.ocg-sub-main .ocg-icon { width: 26px; height: 26px; }
.ocg-sub-main:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ocg-sub-main:focus-visible { box-shadow: inset 0 0 0 2px var(--dsw-alias-border-l3); outline: none; }
.ocg-radio {
  box-sizing: border-box; border: 1.5px solid var(--dsw-alias-border-l4); border-radius: 50%;
  flex: none; width: 15px; height: 15px; position: relative; display: inline-block;
}
.ocg-radio--on { border-color: var(--dsw-alias-brand-primary); }
.ocg-radio--on:after {
  content: ""; position: absolute; inset: 2px; border-radius: 50%; background: var(--dsw-alias-brand-primary);
}
.ocg-sub-name-wrap { align-items: center; gap: 6px; min-width: 0; display: flex; }
.ocg-sub-name {
  color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 20px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ocg-sub--active .ocg-sub-name { font-weight: 600; }
.ocg-pill {
  border: .5px solid transparent; border-radius: 999px; flex: none; padding: 0 7px;
  font-size: 11px; line-height: 16px; white-space: nowrap;
}
.ocg-pill--brand { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.ocg-pill--ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ocg-pill--bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.ocg-pill--dim { color: var(--dsw-alias-label-tertiary); border-color: var(--dsw-alias-border-l3); }

/* Three meters on their own line, sharing it edge to edge (the section caps out
   at 720px, so a meter tops out near 220px — measured in the preview), each cell
   a pill with the reset time underneath it. A window nobody probed renders an
   EMPTY track and an em dash — never a fake 0% — and no reset line either,
   because that moment was never reported. */
.ocg-meters {
  grid-area: 2 / 2 / 3 / -1;
  grid-template-columns: repeat(3, minmax(72px, 1fr)); gap: 6px; align-items: start; display: grid;
}
.ocg-meter-cell { flex-direction: column; gap: 2px; align-items: flex-start; min-width: 0; display: flex; }
.ocg-meter {
  grid-template-columns: 16px minmax(6px, 1fr) 28px; gap: 5px; align-items: center; align-self: stretch;
  padding: 3px 5px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); display: grid;
}
.ocg-meter-label {
  color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px;
  white-space: nowrap; overflow: hidden; text-overflow: clip;
}
.ocg-meter-track { background: var(--dsw-alias-border-l2); border-radius: 999px; height: 5px; overflow: hidden; display: block; }
.ocg-meter-fill { background: var(--dsw-alias-state-success-primary); border-radius: 999px; height: 100%; display: block; transition: width .2s; }
.ocg-meter-value {
  color: var(--dsw-alias-label-secondary); text-align: right; font-size: 11px; line-height: 16px;
  font-variant-numeric: tabular-nums;
}
/* The reset moment, under its own pill: dim, small, and truncated rather than
   wrapped — a second line of text would make the three cells different heights. */
.ocg-meter-reset {
  color: var(--dsw-alias-label-tertiary); font-size: 10.5px; line-height: 14px; max-width: 100%; align-self: stretch;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ocg-meter[data-tone="warn"] .ocg-meter-fill { background: var(--dsw-alias-state-warning-primary); }
.ocg-meter[data-tone="warn"] .ocg-meter-value { color: var(--dsw-alias-state-warning-primary); }
.ocg-meter[data-tone="bad"] .ocg-meter-fill { background: var(--dsw-alias-state-error-primary); }
.ocg-meter[data-tone="bad"] .ocg-meter-value { color: var(--dsw-alias-state-error-primary); }
.ocg-meter[data-tone="none"] .ocg-meter-fill { background: 0 0; }
.ocg-meter[data-tone="none"] .ocg-meter-value { color: var(--dsw-alias-label-dimmed); }

.ocg-sub-body { border-top: .5px solid var(--dsw-alias-border-l2); padding: 10px 13px 12px; flex-direction: column; gap: 10px; display: flex; }
.ocg-sub-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 12px; display: grid; }
.ocg-sub-meta { align-items: center; gap: 8px; flex-wrap: wrap; display: flex; }
.ocg-sub-slot {
  color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, monospace); font-size: 11px;
  line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ocg-sub-meta-end { margin-left: auto; }
.ocg-unsynced { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; padding: 4px 4px 2px; }
.ocg-model-idwrap { align-items: center; gap: 6px; min-width: 0; display: flex; }
.ocg-dead { padding: 0 4px; }
.ocg-model-advanced { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; padding: 8px 4px 2px; display: grid; }
.ocg-model-field { flex-direction: column; gap: 4px; display: flex; }
.ocg-model-field--wide { grid-column: 1 / -1; }
.ocg-model-field-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.ocg-model-empty { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; border: 1px dashed var(--dsw-alias-border-l3); text-align: center; border-radius: 8px; padding: 12px; }
.ocg-adder { gap: 8px; align-items: center; display: flex; }
.ocg-adder .ocg-input { flex: 1 1 auto; }
.ocg-add-hint { padding: 0 2px; }
.ocg-add-btn {
  box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l3); height: 28px; color: var(--dsw-alias-label-primary);
  font: inherit; cursor: pointer; background: 0 0; border-radius: 14px; align-self: flex-start; align-items: center; gap: 4px;
  padding: 0 10px; font-size: 12px; line-height: 18px; display: inline-flex;
}
.ocg-add-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ocg-add-btn:disabled { opacity: .4; cursor: default; }
.ocg-input {
  box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l4); width: 100%; height: 32px; font: inherit;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 0 10px;
  font-size: 14px; line-height: 22px;
}
select.ocg-input { cursor: pointer; max-width: 240px; }
.ocg-input:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.ocg-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.ocg-input:disabled { opacity: .6; cursor: default; }
.ocg-input--bad { border-color: var(--dsw-alias-state-error-primary); }
.ocg-select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 12px center; background-repeat: no-repeat; background-size: 12px 12px; padding-right: 32px;
}
.ocg-switchrow { align-items: flex-start; gap: 8px; cursor: pointer; display: flex; }
.ocg-switch {
  appearance: none; box-sizing: border-box; margin: 3px 0 0; border: none; background: var(--dsw-alias-border-l3);
  border-radius: 8px; flex: none; width: 28px; height: 16px; position: relative; cursor: pointer; transition: background .12s;
}
.ocg-switch:checked { background: var(--dsw-alias-brand-primary); }
.ocg-switch:after {
  content: ""; position: absolute; top: 2px; left: 2px; border-radius: 50%; width: 12px; height: 12px;
  background: var(--dsw-alias-label-primary-foreground); transition: transform .12s;
}
.ocg-switch:checked:after { transform: translateX(12px); }
.ocg-switch:disabled { opacity: .4; cursor: default; }
.ocg-switch:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); outline: none; }
.ocg-switchrow-text { flex-direction: column; gap: 2px; display: flex; }
.ocg-switchrow-label { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; line-height: 18px; }
.ocg-chip-btn {
  box-sizing: border-box; height: 24px; border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary);
  font: inherit; cursor: pointer; background: 0 0; border-radius: 12px; justify-content: center; align-items: center;
  padding: 0 10px; font-size: 12px; line-height: 22px; display: inline-flex;
}
.ocg-chip-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ocg-chip-btn[data-on="1"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.ocg-chip-btn:disabled { opacity: .4; cursor: default; }
.ocg-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 18px; }
.ocg-table th, .ocg-table td { text-align: left; padding: 4px 8px; border-bottom: .5px solid var(--dsw-alias-border-l2); vertical-align: top; }
.ocg-table th { color: var(--dsw-alias-label-tertiary); font-weight: 500; white-space: nowrap; }
.ocg-table td { color: var(--dsw-alias-label-secondary); word-break: break-word; }
.ocg-subhead { color: var(--dsw-alias-label-secondary); margin: 0; font-size: 12px; font-weight: 500; line-height: 18px; }
.ocg-log {
  max-height: 240px; overflow: auto; font-family: var(--ds-font-family-code, monospace); font-size: 11px; line-height: 16px;
  white-space: pre-wrap; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 8px 10px;
}
.ocg-dialog { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, .35); }
.ocg-dialog-body {
  box-sizing: border-box; width: min(520px, 92vw); max-height: 84vh; overflow: auto; border-radius: 16px; padding: 16px;
  border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); flex-direction: column; gap: 12px;
  display: flex; box-shadow: 0 16px 48px rgba(0, 0, 0, .16);
}
.ocg-dialog-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }
.ocg-dialog-foot { justify-content: flex-end; gap: 8px; display: flex; }
.ocg-candidate-toolbar { align-items: center; gap: 8px; display: flex; }
.ocg-candidate-toolbar .ocg-input { flex: 240px; min-width: 0; }
.ocg-candidate-list { flex-direction: column; gap: 2px; max-height: 320px; margin: 0; padding: 0; list-style: none; display: flex; overflow-y: auto; }
.ocg-candidate { border-radius: 6px; }
.ocg-candidate--on { background: var(--dsw-alias-interactive-bg-hover); }
.ocg-candidate-label { cursor: pointer; align-items: center; gap: 8px; padding: 6px 8px; display: flex; }
.ocg-candidate-label:hover { background: var(--dsw-alias-interactive-bg-hover); border-radius: 6px; }
.ocg-candidate input[type="checkbox"] { accent-color: var(--dsw-alias-brand-primary); }
.ocg-candidate-id { font-family: var(--ds-font-family-code, monospace); overflow-wrap: anywhere; flex: auto; font-size: 13px; }
.ocg-candidate-name { color: var(--dsw-alias-label-tertiary); flex: none; font-size: 12px; line-height: 18px; }
.ocg-candidate-empty { color: var(--dsw-alias-label-secondary); text-align: center; margin: 24px 0; font-size: 13px; line-height: 20px; }
@media (prefers-reduced-motion: reduce) { .ocg-details-summary:before, .ocg-switch, .ocg-switch:after { transition: none; } }
`

/** The official 14px chevron, rotated a quarter turn while its row is open. */
function IconChevron(props) {
  return React.createElement('svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    style: { transform: props.open === true ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' },
  }, React.createElement('path', {
    d: 'M6 3.5L10.5 8L6 12.5',
    stroke: 'currentColor',
    strokeWidth: '1.5',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
}

/** The official 14px trash glyph for a row's remove act. */
function IconTrash() {
  return React.createElement('svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
  }, React.createElement('path', {
    d: 'M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4',
    stroke: 'currentColor',
    strokeWidth: '1.3',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }))
}

/**
 * One text input with its label, hint and inline error.
 *
 * `variant` picks the type scale: top-level fields sit on the module panel with
 * the 12/18 secondary label, while a row's expanded attributes use the smaller
 * tertiary label of the official model-advanced grid.
 *
 * `onCommit` is the auto-save hook: blur and Enter both fire it, which is how a
 * write-only secret reaches the store exactly once (the caller debounces the
 * ordinary fields, but a key must never be written character by character).
 */
function TextField(props) {
  const { label, value, onChange, hint, error, placeholder, disabled, type, field, variant, onCommit } = props
  const model = variant === 'model'
  return React.createElement('label', { className: model ? 'ocg-model-field' : 'ocg-field' },
    React.createElement('span', { className: model ? 'ocg-model-field-label' : 'ocg-field-label' }, label),
    React.createElement('input', {
      className: error === undefined ? 'ocg-input' : 'ocg-input ocg-input--bad',
      'data-ocg-field': field,
      type: type ?? 'text',
      value: value ?? '',
      placeholder,
      disabled,
      'aria-invalid': error === undefined ? undefined : 'true',
      onChange: (event) => onChange(event.target.value),
      onBlur: onCommit === undefined ? undefined : () => onCommit(),
      onKeyDown: onCommit === undefined ? undefined : (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit()
        }
      },
    }),
    hint === undefined ? null : React.createElement('span', { className: 'ocg-hint' }, hint),
    error === undefined ? null : React.createElement('p', { className: 'ocg-error' }, error),
  )
}

/** One dropdown over a fixed vocabulary. */
function SelectField(props) {
  const { label, value, options, onChange, hint, error, allowBlank, blankLabel, disabled, field, variant } = props
  const model = variant === 'model'
  return React.createElement('label', { className: model ? 'ocg-model-field' : 'ocg-field' },
    React.createElement('span', { className: model ? 'ocg-model-field-label' : 'ocg-field-label' }, label),
    React.createElement('select', {
      className: error === undefined ? 'ocg-input ocg-select' : 'ocg-input ocg-select ocg-input--bad',
      'data-ocg-field': field,
      value: value ?? '',
      disabled,
      onChange: (event) => onChange(event.target.value),
    },
      allowBlank === true ? React.createElement('option', { value: '' }, blankLabel ?? '（不指定）') : null,
      options.map((option) => React.createElement('option', { key: option, value: option }, option)),
    ),
    hint === undefined ? null : React.createElement('span', { className: 'ocg-hint' }, hint),
    error === undefined ? null : React.createElement('p', { className: 'ocg-error' }, error),
  )
}

/** One switch row: the official toggle shape over a native checkbox. */
function SwitchRow(props) {
  const { label, checked, onChange, hint, disabled, field, variant } = props
  const model = variant === 'model'
  const text = React.createElement('span', { className: 'ocg-switchrow-text' },
    React.createElement('span', { className: 'ocg-switchrow-label' }, label),
    hint === undefined ? null : React.createElement('span', { className: 'ocg-hint' }, hint),
  )
  if (model === true) {
    return React.createElement('label', { className: 'ocg-switchrow', style: { alignItems: 'center' } },
      React.createElement('input', {
        type: 'checkbox',
        className: 'ocg-switch',
        style: { margin: 0 },
        checked: checked === true,
        disabled,
        'data-ocg-field': field,
        onChange: (event) => onChange(event.target.checked),
      }),
      text,
    )
  }
  return React.createElement('label', { className: 'ocg-switchrow' },
    React.createElement('input', {
      type: 'checkbox',
      className: 'ocg-switch',
      checked: checked === true,
      disabled,
      'data-ocg-field': field,
      onChange: (event) => onChange(event.target.checked),
    }),
    text,
  )
}

/** One multi-select chip row over a small vocabulary (a row's expanded grid). */
function ChipField(props) {
  const { label, values, options, onChange, hint, error, disabled, field, wide } = props
  const list = Array.isArray(values) ? values : []
  return React.createElement('div', {
    className: wide === true ? 'ocg-model-field ocg-model-field--wide' : 'ocg-model-field',
    'data-ocg-field': field,
  },
    React.createElement('span', { className: 'ocg-model-field-label' }, label),
    React.createElement('div', { className: 'ocg-chips', style: { padding: 0 } },
      options.map((option) => React.createElement('button', {
        type: 'button',
        key: option,
        className: 'ocg-chip-btn',
        disabled,
        'data-ocg-option': option,
        'data-on': list.includes(option) ? '1' : '0',
        onClick: () => onChange(list.includes(option) ? list.filter((entry) => entry !== option) : [...list, option]),
      }, option)),
    ),
    hint === undefined ? null : React.createElement('span', { className: 'ocg-hint' }, hint),
    error === undefined ? null : React.createElement('p', { className: 'ocg-error' }, error),
  )
}

/**
 * One capacity input: a blank cell means "inherit the official default", which
 * must stay blank — and the placeholder says which number that is.
 */
function CapacityField(props) {
  const { label, value, onChange, error, placeholder, disabled, field } = props
  return React.createElement('label', { className: 'ocg-model-field' },
    React.createElement('span', { className: 'ocg-model-field-label' }, label),
    React.createElement('input', {
      className: error === undefined ? 'ocg-input' : 'ocg-input ocg-input--bad',
      inputMode: 'numeric',
      disabled,
      placeholder,
      'data-ocg-field': field,
      value: value === '' || value === undefined ? '' : String(value),
      onChange: (event) => {
        const text = event.target.value.trim()
        if (text === '') onChange('')
        else if (/^\d+$/u.test(text)) onChange(Number(text))
      },
    }),
    error === undefined ? null : React.createElement('p', { className: 'ocg-error' }, error),
  )
}

/** The OFFICIAL capability chips one model shows, without expanding it. */
function CapabilityChips(props) {
  const chips = capabilityChips(props.model)
  if (chips.length === 0) return null
  return React.createElement('div', { className: 'ocg-chips', 'data-ocg-chips': String(props.model?.id ?? '') },
    chips.map((chip) => React.createElement('span', {
      key: chip.label,
      className: 'ocg-chip',
      'data-tone': chip.tone,
    }, chip.label)),
  )
}

/**
 * Whether one subscription row's key is STORED, as a one-word pill.
 *
 * Presence only — the value never reaches the page. `undefined` means the
 * credential seam could not answer, which is a different fact from "not stored"
 * and is rendered as such (a dim pill, not a red one).
 */
function CredentialPill(props) {
  const { view } = props
  if (view?.configured === undefined) {
    return React.createElement('span', { className: 'ocg-pill ocg-pill--dim', title: SUBS_KEY_UNKNOWN_HINT }, SUBS_KEY_UNKNOWN)
  }
  if (view.configured === true) {
    const source = typeof view.source === 'string' && view.source.length > 0 ? `（来源 ${view.source}）` : ''
    return React.createElement('span', { className: 'ocg-pill ocg-pill--ok', title: `${SUBS_KEY_STORED}${source}` }, SUBS_KEY_STORED)
  }
  return React.createElement('span', {
    className: 'ocg-pill ocg-pill--bad',
    title: '这条订阅还没有密钥：展开它填一个（离开输入框即写入），或点右边「刷新余额」看状态。',
  }, SUBS_KEY_MISSING)
}

/**
 * One balance window as a compact meter: label, track, percent — and, UNDER the
 * pill, when the window comes back.
 *
 * The percent is the gateway's last-reported number for that key — never a local
 * ledger — so a window nobody probed renders an EMPTY track and an em dash
 * instead of a fake 0%. The reset line appears only when the gateway gave a
 * moment this page can read: an unmeasured window keeps its empty pill and no
 * invented "resets someday". The full sentence stays in the tooltip, together
 * with the local clock time, because the row only has room for "3 小时后".
 */
function Meter(props) {
  const cell = props.cell
  const percent = typeof cell.percent === 'number' ? cell.percent : undefined
  const width = percent === undefined ? 0 : Math.max(0, Math.min(100, percent))
  const reset = resetPhrase(cell.resetsAt)
  const resetShortText = resetShort(cell.resetsAt)
  const stamp = resetStamp(cell.resetsAt)
  const title = [
    cell.label,
    percent === undefined ? (cell.status ?? SUBS_NEVER_PROBED) : `${String(percent)}%`,
    reset === undefined || stamp === undefined ? reset : `${reset}（${stamp}）`,
  ].filter((part) => part !== undefined).join('，')
  return React.createElement('span', {
    className: 'ocg-meter-cell',
    'data-ocg-window': cell.window,
    title,
  },
    React.createElement('span', {
      className: 'ocg-meter',
      'data-tone': cell.tone,
    },
      React.createElement('span', { className: 'ocg-meter-label' }, cell.short ?? cell.label),
      React.createElement('span', { className: 'ocg-meter-track' },
        React.createElement('span', { className: 'ocg-meter-fill', style: { width: `${String(width)}%` } })),
      React.createElement('span', { className: 'ocg-meter-value' }, percent === undefined ? '—' : `${String(percent)}%`),
    ),
    resetShortText === undefined
      ? null
      : React.createElement('span', {
        className: 'ocg-meter-reset',
        'data-ocg-reset': cell.window,
      }, resetShortText),
  )
}

/**
 * Render the OpenCode Go settings section.
 *
 * Props come from two places: the settings slot renderer supplies the runtime
 * share (`close`) and the locale seat, and the registration's `inject` face
 * supplies `api` (see `./index.js`).
 *
 * @param {object} props - the section props.
 * @returns {object} the rendered section.
 */
export function OpenCodeGoSection(props) {
  const { api } = props

  const [status, setStatus] = useState('loading')
  const [loadError, setLoadError] = useState(undefined)
  const [writable, setWritable] = useState(true)
  const [revision, setRevision] = useState(undefined)
  const [view, setView] = useState(undefined)
  const [clean, setClean] = useState(undefined)
  const [draft, setDraft] = useState(undefined)
  const [legacyKey, setLegacyKey] = useState(false)

  const [fieldErrors, setFieldErrors] = useState({})
  const [banner, setBanner] = useState(undefined)
  /** How many settings writes are in flight (the auto-save indicator reads this). */
  const [writing, setWriting] = useState(0)
  const [conflict, setConflict] = useState(false)

  const [catalogue, setCatalogue] = useState(undefined)
  const [catalogueError, setCatalogueError] = useState(undefined)
  const [refreshNote, setRefreshNote] = useState(undefined)
  const [expanded, setExpanded] = useState(() => new Set())
  const [picker, setPicker] = useState({ busy: false, candidates: undefined, error: undefined, wanted: [], query: '' })
  const [adder, setAdder] = useState({ open: false, id: '' })

  // The subscription/balance rows (0.8). The page LOADS the cached view (the
  // server's last probe), and 刷新余额 asks for a fresh one — the same
  // cached-first discipline as the model catalogue.
  const [usage, setUsage] = useState({ busy: false, rows: undefined, error: undefined })
  const [diagnostics, setDiagnostics] = useState({ busy: false, view: undefined, error: undefined, open: false })
  // One model per request: the page owns the loop, so progress is real and a
  // stop takes effect between models rather than abandoning a long reply.
  const [sync, setSync] = useState({ busy: false, done: 0, total: 0, current: undefined, results: {}, error: undefined, stopped: false, startedAt: undefined })
  const syncStop = useRef(false)
  const syncAbort = useRef(undefined)
  // A second-by-second clock, so a slow model shows movement instead of the
  // same sentence for minutes. Only runs while a sync is in flight.
  const [syncClock, setSyncClock] = useState(() => Date.now())
  useEffect(() => {
    if (sync.busy !== true) return undefined
    const timer = setInterval(() => setSyncClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sync.busy])

  // ── auto-save plumbing ─────────────────────────────────────────────────────
  // There is no 保存 button any more: a change IS the commit. React state alone
  // cannot drive that (a handler that fires twice before a re-render would read
  // a stale draft), so the three facts every write needs are mirrored into refs:
  // what the operator is editing, what the server last confirmed, and the
  // revision that confirmation carried.
  const draftRef = useRef(undefined)
  const cleanRef = useRef(undefined)
  const revisionRef = useRef(undefined)
  /** The tail of the write queue: settings writes are serialized, never raced. */
  const writeChain = useRef(Promise.resolve())
  /** The debounce handle for ordinary (non-secret) edits. */
  const flushTimer = useRef(undefined)
  /** Rows whose staged key is being written right now, so a re-render cannot double-write. */
  const credentialWrites = useRef(new Set())

  const applyDraft = (next) => {
    draftRef.current = next
    setDraft(next)
    return next
  }
  const applyClean = (next) => {
    cleanRef.current = next
    setClean(next)
    return next
  }
  const applyRevision = (next) => {
    revisionRef.current = next
    setRevision(next)
    return next
  }

  /**
   * Serialize one settings write behind every write already queued.
   *
   * A queued write reads the refs when it RUNS, not when it was scheduled, so an
   * edit made while an earlier write was in flight is written next instead of
   * being swallowed by a stale diff.
   */
  const enqueueWrite = (task) => {
    const run = () => {
      setWriting((count) => count + 1)
      return task().finally(() => setWriting((count) => Math.max(0, count - 1)))
    }
    const next = writeChain.current.then(run, run)
    writeChain.current = next.catch(() => {})
    return next
  }

  /**
   * Adopt a write's reply as the new baseline without discarding live typing.
   *
   * When the draft has not moved since the write was sent, the reply IS the
   * draft (that is what makes the form round-trip). When it HAS moved, the
   * operator is mid-edit: the reply becomes the baseline and the draft stays,
   * so the still-dirty field is simply written by the next flush.
   */
  const adoptReply = (reply, sent) => {
    const rebuilt = reply === undefined ? undefined : namespaceViewOf({ namespaces: [reply] })
    if (rebuilt === undefined) return false
    const stored = formFromView(rebuilt)
    // A reply never carries a secret (the settings document holds slot NAMES),
    // so any key still staged in the draft has to ride across this adoption —
    // otherwise the write that committed the row's NAME would silently eat the
    // key the operator pasted beside it.
    const staged = new Map((Array.isArray(sent?.subscriptions) ? sent.subscriptions : [])
      .filter((row) => typeof row?.apiKey === 'string' && row.apiKey.trim().length > 0)
      .map((row) => [row.key, row.apiKey]))
    const carryStaged = (form) => (staged.size === 0 ? form : {
      ...form,
      subscriptions: (Array.isArray(form.subscriptions) ? form.subscriptions : [])
        .map((row) => (staged.has(row.key) ? { ...row, apiKey: staged.get(row.key) } : row)),
    })
    setView(rebuilt)
    applyRevision(revisionFor(rebuilt))
    setLegacyKey(legacyApiKeyPresent(rebuilt))
    setFieldErrors({})
    setConflict(false)
    applyClean(stored)
    if (deepEqual(draftRef.current, sent)) applyDraft(carryStaged(stored))
    return true
  }

  /** The one place a host rejection becomes the operator's field errors and banner. */
  const handleWriteFailure = (error) => {
    const message = describeFailure(error)
    const paths = errorPathsOf(message)
    const mapped = {}
    for (const path of paths) mapped[path] = message
    setFieldErrors(mapped)
    if (isConflictFailure(error)) {
      setConflict(true)
      setBanner({ kind: 'error', text: `另一个标签页先改过了。这里有你的改动，点「重新载入」后再改一次。\n${message}` })
    } else if (paths.length === 0) {
      setBanner({ kind: 'error', text: message })
    } else {
      setBanner({ kind: 'error', text: `宿主拒绝了这次写入（已定位到 ${paths.join('、')}）：${message}` })
    }
  }

  /**
   * Queue one settings write, computing its ops when it RUNS.
   *
   * The op list is built inside the queued task, not when it was scheduled, so a
   * write that follows an earlier one sees the baseline that earlier one
   * produced (and its revision). A stale `expectedRevision` is refused by the
   * host as a conflict, which is the one failure mode this avoids by design.
   */
  const queueSettingsWrite = (makeOps, onDone) => enqueueWrite(() => {
    const sent = draftRef.current
    const cleanNow = cleanRef.current
    if (sent === undefined || cleanNow === undefined) return Promise.resolve()
    const ops = makeOps(cleanNow, sent)
    if (!Array.isArray(ops) || ops.length === 0) return Promise.resolve()
    return api.mutateSettings(SETTINGS_NS, ops, revisionRef.current)
      .then((reply) => {
        adoptReply(reply, sent)
        onDone?.()
      })
      .catch(handleWriteFailure)
  })

  /**
   * Write every settings path the draft has moved, and nothing else.
   *
   * This is the whole of "改动立即生效": the debounce only batches keystrokes,
   * and the op list is computed from `writeOps`, which diffs against the last
   * confirmed baseline — so an unrelated half-typed field is never smuggled in.
   */
  const flushSettings = () => {
    if (flushTimer.current !== undefined) {
      clearTimeout(flushTimer.current)
      flushTimer.current = undefined
    }
    if (!writable) return Promise.resolve()
    // A draft the LOCAL validator already refuses is not sent: the inline error
    // is the answer, and the host would only repeat it. (This is the old 保存
    // rule kept alive without the button — it never blocked on a half-typed
    // blank row, which `validateForm` deliberately tolerates.)
    if (Object.keys(validateForm(draftRef.current)).length > 0) return Promise.resolve()
    return queueSettingsWrite((clean, draft) => writeOps(clean, draft))
  }

  /** Batch keystrokes: an ordinary edit commits ~0.4s after the operator pauses. */
  const scheduleFlush = (delay = 400) => {
    if (flushTimer.current !== undefined) clearTimeout(flushTimer.current)
    flushTimer.current = setTimeout(() => {
      flushTimer.current = undefined
      void flushSettings()
    }, delay)
  }

  /**
   * Store one row's staged key.
   *
   * Secrets are NEVER debounced: a key reaches the store on blur/Enter (or, for
   * the row being selected, immediately before the pointer moves), so a
   * half-typed value can never be written. A value typed while a write is in
   * flight is written right after it — the loop only re-enters for a value that
   * actually changed.
   */
  const storeRowCredential = (rowKey) => {
    if (credentialWrites.current.has(rowKey)) return Promise.resolve()
    const plan = stagedCredentialPlanFor(draftRef.current, rowKey)
    if (plan === undefined) return Promise.resolve()
    credentialWrites.current.add(rowKey)
    return api.storeCredential(plan.reference, plan.value).then((failure) => {
      credentialWrites.current.delete(rowKey)
      if (failure !== undefined) {
        setBanner({ kind: 'error', text: `密钥没写进凭据存储：${failure}` })
        return
      }
      // The form must not keep a copy of a secret that is now stored: the next
      // unrelated write would re-send it. Only THIS value is cleared — a newer
      // one typed while the write was in flight is left staged.
      const cleared = (state) => (state === undefined ? state : {
        ...state,
        subscriptions: (Array.isArray(state.subscriptions) ? state.subscriptions : [])
          .map((row) => (row.key === rowKey && row.apiKey.trim() === plan.value ? { ...row, apiKey: '' } : row)),
      })
      const replaced = stagedCredentialPlanFor(draftRef.current, rowKey)
      applyDraft(cleared(draftRef.current))
      // A key that was just stored has never been measured, so its bars are
      // empty: ask for the stale ones now (the host skips this row when it is
      // already fresh, so pasting a key cannot re-probe a reading it has).
      void loadUsage('auto')
      if (replaced !== undefined && replaced.value !== plan.value) return storeRowCredential(rowKey)
      return undefined
    }, (error) => {
      // A transport failure must not leave the row marked "writing" forever, and
      // must not cost the operator the key they pasted.
      credentialWrites.current.delete(rowKey)
      setBanner({ kind: 'error', text: `密钥没写进凭据存储：${describeFailure(error)}` })
      return undefined
    })
  }

  /**
   * The cached-or-refreshed subscription rows: label, credential slot, which row
   * is ACTIVE, whether a key is stored, and the balance the gateway last
   * reported. A failure never blanks what is known.
   *
   * `refresh` is the mode the host route understands: `false` = the cache as it
   * stands, `'auto'` = probe the rows whose last good reading is older than the
   * host's TTL, `true` = probe everything. Both probing modes are "we are asking
   * the gateway right now", so both turn the 刷新余额 button into 查询中….
   */
  const loadUsage = (refresh) => {
    const probing = refresh === true || refresh === 'auto'
    if (probing) setUsage((state) => ({ ...state, busy: true, error: undefined }))
    return api.usage(refresh)
      .then((payload) => {
        const parsed = usageView(payload)
        setUsage({ busy: false, rows: parsed.subs, error: parsed.refreshError })
        return parsed
      })
      .catch((error) => {
        setUsage((state) => ({ ...state, busy: false, error: describeFailure(error) }))
        return undefined
      })
  }

  /** The effective model list, for the rows and the adder's advertised set. */
  const loadCatalogue = (refresh) => {
    setCatalogueError(undefined)
    return api.catalogue(refresh === true)
      .then((payload) => {
        const parsed = catalogueView(payload)
        setCatalogue(parsed.models)
        setRefreshNote(parsed.refreshError)
        return parsed
      })
      .catch((error) => {
        setCatalogueError(describeFailure(error))
        return undefined
      })
  }

  /** Load (or reload) the namespace view and rebuild the draft. */
  const load = () => {
    setStatus('loading')
    setLoadError(undefined)
    return api.describeSettings()
      .then((described) => {
        const found = namespaceViewOf(described)
        if (found === undefined) {
          setStatus('missing')
          setLoadError(`设置里没有命名空间 ${SETTINGS_NS}：插件宿主半没有装载，或这次组合里没有 settings 服务。`)
          return undefined
        }
        const next = formFromView(found)
        setView(found)
        setWritable(described.writable !== false)
        applyRevision(revisionFor(found))
        applyDraft(next)
        applyClean(next)
        setLegacyKey(legacyApiKeyPresent(found))
        setFieldErrors({})
        setBanner(undefined)
        setConflict(false)
        setStatus('ready')
        // The cache PAINTS first (the rows are on screen before any request to
        // the gateway is even made), then the panel asks for a live reading of
        // whatever is stale. Opening the panel is not a user act worth a full
        // forced probe, and it is exactly the moment a stale number is most
        // misleading — so the host's own TTL decides which rows get asked.
        return Promise.all([loadCatalogue(false), loadUsage(false)])
          .then(() => loadUsage('auto'))
      })
      .catch((error) => {
        setStatus('error')
        setLoadError(describeFailure(error))
      })
  }

  useEffect(() => {
    void load()
    return undefined
  }, [])

  const errors = useMemo(() => {
    const local = draft === undefined ? {} : validateForm(draft)
    return { ...local, ...fieldErrors }
  }, [draft, fieldErrors])

  /** A settings write is in flight right now (the head's quiet status and the act guards read this). */
  const busy = writing > 0

  /** Patch one top-level form key (auto-saved). */
  const patch = (key, value) => {
    applyDraft({ ...draftRef.current, [key]: value })
    setBanner(undefined)
    scheduleFlush()
  }

  /**
   * Apply one directory edit and clear the stale banner.
   *
   * The argument may be a VALUE or a function of the previous draft, and the
   * function form is the correct one for everything that reads the draft: two
   * handlers firing before React re-renders (a paste into the key field while a
   * name edit is still queued) both close over the SAME draft, so a value-based
   * update would silently drop the first one.
   */
  const applyDirectory = (next, options) => {
    applyDraft(typeof next === 'function' ? next(draftRef.current) : next)
    setBanner(undefined)
    scheduleFlush(options?.immediate === true ? 0 : 400)
  }

  /** Toggle one row's advanced panel. */
  const toggleExpanded = (key) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }

  /**
   * Commit a model act (pick, add, remove) straight to settings.
   *
   * This is what makes the picker's promise true — "选择即激活": the write
   * carries ONLY the models paths that moved, so unrelated half-typed scalars
   * in the same draft stay drafts, and the route's catalogue (the host
   * re-derives it from the same document) serves the new set on the next
   * request with no further clicking.
   */
  const commitModels = (nextDraft, successText) => {
    if (nextDraft === undefined || cleanRef.current === undefined || !writable) return
    const local = validateForm(nextDraft)
    const modelProblems = Object.entries(local).filter(([path]) => path.startsWith('models'))
    if (modelProblems.length > 0) {
      applyDraft(nextDraft)
      setBanner({ kind: 'error', text: `模型设置有冲突：${modelProblems[0][1]}` })
      return
    }
    if (modelsWriteOps(cleanRef.current, nextDraft).length === 0) {
      applyDraft(nextDraft)
      return
    }
    applyDraft(nextDraft)
    void queueSettingsWrite(
      (clean, draft) => modelsWriteOps(clean, draft),
      () => {
        void loadCatalogue(false)
        if (successText !== undefined) setBanner({ kind: 'ok', text: successText })
      },
    )
  }

  /**
   * Remove the stored API key behind one subscription row.
   *
   * EVERY spelling the row can hold a key under is cleared — its own slot and the
   * legacy ones the host reads as a fallback. Clearing only the primary would
   * leave an older copy behind that the request path would happily resurrect
   * after a "delete".
   */
  const clearCredential = (row) => {
    const primary = subscriptionSlots(draftRef.current).get(row.key)
    if (typeof primary !== 'string' || primary.length === 0) {
      setBanner({ kind: 'error', text: '这一行还没有名字，也就没有凭据槽位可清。' })
      return
    }
    const legacy = (usage.rows ?? [])
      .find((entry) => entry.id === row.id)?.fallbackRefs ?? []
    setBanner(undefined)
    void [...new Set([primary, ...legacy])]
      .reduce((chain, reference) => chain.then(async (failed) => {
        if (failed !== undefined) return failed
        return await api.removeCredential(reference)
      }), Promise.resolve(undefined))
      .then((failure) => {
        if (failure !== undefined) {
          setBanner({ kind: 'error', text: `清除凭据失败：${failure}` })
          return
        }
        // The LIVE slot may still hold the removed value until the next
        // reconciliation; reading the rows back is what makes the page show the
        // truth instead of the last thing it saw.
        void loadUsage(false)
      })
  }

  /**
   * Switch who pays, in ONE click.
   *
   * Activation is a settings write of its own, and there is no 保存 step for it
   * to wait on: the key staged in that row (if the operator just typed one) is
   * stored FIRST, then the pointer moves — so the row the click selected is the
   * row the very next request spends. The write carries the subscription list
   * too, because a row that was just added has no stored id for the pointer to
   * name yet.
   *
   * No banner: the row's radio, the 「当前」 badge and the balance bars already
   * say what happened, and a toast for a successful click is noise the operator
   * has to dismiss in their head.
   */
  const activate = (rowKey) => {
    if (cleanRef.current === undefined || draftRef.current === undefined || !writable) return
    const rows = Array.isArray(draftRef.current.subscriptions) ? draftRef.current.subscriptions : []
    const target = rows.find((row) => row.key === rowKey)
    if (target === undefined) return
    // A row with no name has no id and no credential slot yet, so there is
    // nothing coherent to point at: ask for the name first instead of writing a
    // pointer the host would resolve back to `default`.
    if (target.isDefault !== true && target.label.trim().length === 0) {
      setBanner({ kind: 'error', text: '先给这条订阅起个名字（展开这一行填「名字」）再点它切换。' })
      return
    }
    setBanner(undefined)
    // The key staged in that row belongs to the row being selected: store it
    // FIRST, so selecting cannot point at a slot that is still empty. A failed
    // store still moves the pointer (the row's name is what the pointer needs),
    // and the flag it reports is what tells the operator the key is missing.
    void storeRowCredential(rowKey).then(() => {
      applyDraft(activateSubscription(draftRef.current, rowKey))
      void queueSettingsWrite(
        (clean, draft) => activationWriteOps(clean, draft, rowKey),
        // The balance bars belong to the key that now pays — and a key nobody
        // has measured yet gets measured here, so switching to a row is enough
        // to see what is left on it.
        () => { void loadUsage('auto') },
      ).then(() => {
        // Backstop: if the click left the form dirty — a shape the targeted op
        // list could not express, or a field that also moved — the general
        // writer converges it. Without this the page could sit on a pointer the
        // host never received, which is exactly what it must never do.
        if (isDirty(cleanRef.current, draftRef.current)) scheduleFlush(0)
      })
    })
  }

  /** The key just typed into the ACTIVE row, if any (used for one discovery call). */
  const exactActiveStagedKey = () => {
    const rows = Array.isArray(draft?.subscriptions) ? draft.subscriptions : []
    const active = rows.find((row) => row.key === draft?.activeSubscription
      || (row.id !== '' && row.id === draft?.activeSubscription))
    const value = typeof active?.apiKey === 'string' ? active.apiKey.trim() : ''
    return value.length > 0 ? value : undefined
  }

  /** Interrogate the gateway and open the picker with the CURRENT selection. */
  const openPicker = () => {
    setPicker((state) => ({ ...state, busy: true, error: undefined, candidates: undefined }))
    const body = {}
    if (typeof draft?.baseURL === 'string' && draft.baseURL.trim().length > 0) body.baseURL = draft.baseURL.trim()
    // A key just typed into the ACTIVE row is used for THIS request only and is
    // never stored here: storing a secret is the field's own on-blur act (see
    // `storeRowCredential`). Otherwise the host resolves the active row's key.
    const activeKey = exactActiveStagedKey()
    if (activeKey !== undefined) body.apiKey = activeKey
    api.discoverDraft(body)
      .then((payload) => {
        const parsed = catalogueView(payload)
        if (parsed.models.length === 0) {
          setPicker({ busy: false, candidates: [], error: FETCH_EMPTY, wanted: [], query: '' })
          return
        }
        const ids = parsed.models.map((model) => model.id)
        setPicker({
          busy: false,
          candidates: parsed.models,
          error: undefined,
          // Checked = enabled right now (draft in effect), so the dialog is a
          // selection, not an "add" list: whatever the operator leaves checked
          // is exactly what stays on.
          wanted: parsed.models.filter((model) => isModelEnabled(model.id, draft, ids)).map((model) => model.id),
          query: '',
        })
      })
      .catch((error) => {
        setPicker({ busy: false, candidates: undefined, error: describeFailure(error), wanted: [], query: '' })
      })
  }

  /** Fold the picker's checked-set into the draft AND commit it. */
  const applySelection = () => {
    const candidates = picker.candidates ?? []
    const next = setModelSelection(draft, candidates, picker.wanted ?? [])
    const added = (picker.wanted ?? []).filter((id) => !isModelEnabled(id, draft, candidates.map((model) => model.id)))
    const removed = candidates
      .map((model) => model.id)
      .filter((id) => isModelEnabled(id, draft, candidates.map((model) => model.id)) && !(picker.wanted ?? []).includes(id))
    const parts = [
      added.length === 0 ? undefined : `启用 ${String(added.length)} 个`,
      removed.length === 0 ? undefined : `停用 ${String(removed.length)} 个`,
    ].filter((entry) => entry !== undefined)
    setPicker({ busy: false, candidates: undefined, error: undefined, wanted: [], query: '' })
    commitModels(next, parts.length === 0 ? undefined : `已${parts.join('，')}并保存。`)
  }

  /** Add one typed id and activate it in the same act. */
  const addModel = () => {
    const id = adder.id.trim()
    if (id.length === 0) return
    const advertisedIds = (catalogue ?? []).map((model) => model.id)
    const next = addModelById(draft, id, advertisedIds)
    setAdder({ open: false, id: '' })
    commitModels(next, `已添加并启用 ${id}。`)
  }

  /**
   * Sync every ENABLED model, one at a time, showing real progress.
   *
   * One request per model is deliberate: the operator sees which model is being
   * asked about, a stop lands between models, and a slow gateway cannot hold a
   * single request open for the whole list. The route persists each result as it
   * answers, so stopping half way keeps the half that finished.
   */
  const runSync = async () => {
    const ids = syncTargetIds(rows)
    if (ids.length === 0) return
    syncStop.current = false
    syncAbort.current = new AbortController()
    const startedAt = Date.now()
    setSync({ busy: true, done: 0, total: ids.length, current: ids[0], results: {}, error: undefined, stopped: false, startedAt })
    for (let index = 0; index < ids.length; index += 1) {
      if (syncStop.current) break
      const id = ids[index]
      setSync((state) => ({ ...state, current: id }))
      try {
        // The signal lets 停止 interrupt the request that is IN FLIGHT, not just
        // the next one: otherwise a stop during a slow model does nothing at all
        // until that model finishes.
        const payload = await api.syncModel(id, { signal: syncAbort.current.signal })
        const result = unwrapPayload(payload).sync
        setSync((state) => ({ ...state, done: index + 1, results: { ...state.results, [id]: result } }))
      } catch (error) {
        // A stop is the operator's own doing, not a failure to report.
        if (syncStop.current) break
        setSync((state) => ({ ...state, done: index + 1, error: describeFailure(error) }))
      }
    }
    syncAbort.current = undefined
    setSync((state) => ({ ...state, busy: false, current: undefined, stopped: syncStop.current }))
    // The route persisted each verdict as it answered, so the stored synced
    // layer moved under us: refresh the catalogue so every row swaps the
    // "能力信息还没取过" hint for the saved capability chips without a reload.
    void loadCatalogue(false)
  }

  const showDiagnostics = () => {
    setDiagnostics((state) => ({ ...state, busy: true, error: undefined, open: true }))
    api.diagnostics()
      .then((payload) => {
        setDiagnostics({ busy: false, view: diagnosticsView(payload), error: undefined, open: true })
      })
      .catch((error) => {
        setDiagnostics({ busy: false, view: undefined, error: describeFailure(error), open: true })
      })
  }

  if (status === 'loading') {
    return React.createElement('div', { className: 'ocg-section' },
      React.createElement('style', null, SECTION_CSS),
      React.createElement('p', { className: 'ocg-intro' }, '正在读取设置…'),
    )
  }
  if (status !== 'ready' || draft === undefined) {
    return React.createElement('div', { className: 'ocg-section' },
      React.createElement('style', null, SECTION_CSS),
      React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, loadError ?? '设置不可用'),
      React.createElement('div', null,
        React.createElement('button', { type: 'button', className: 'ocg-btn ocg-btn--secondary', onClick: () => void load() }, '重试')),
    )
  }

  const rows = directoryRows(draft, catalogue ?? [])
  const byId = new Map((catalogue ?? []).map((model) => [model.id, model]))
  const enabledCount = rows.filter((row) => row.id.length > 0).length

  /**
   * The inline error for one control.
   *
   * Two spellings reach this map and both must land on the same row: the CLIENT
   * validator keys by row index (`models.extra[0].contextWindow`), while the
   * HOST rejection keys by model id (`models.extra["broken-extra"].contextWindow`).
   * Checking both is what keeps a host rejection beside the control that caused it.
   */
  const cellError = (row, field) => {
    const branch = row.extra !== undefined ? 'extra' : 'overrides'
    if (row.id.length > 0) {
      const byIdError = errors[`models.${branch}[${row.id}].${field}`]
      if (byIdError !== undefined) return byIdError
    }
    const list = row.extra !== undefined ? draft.extra : draft.overrides
    const target = row.extra ?? row.override
    const index = target === undefined ? -1 : list.indexOf(target)
    return index === -1 ? undefined : errors[`models.${branch}[${String(index)}].${field}`]
  }

  /** The values one row edits, from its extra declaration or its override. */
  const cellsOf = (row) => {
    const source = row.extra ?? row.override ?? {}
    return {
      id: row.id,
      name: row.extra !== undefined ? row.extra.name : '',
      api: typeof source.api === 'string' ? source.api : '',
      contextWindow: source.contextWindow === undefined ? '' : source.contextWindow,
      maxTokens: source.maxTokens === undefined ? '' : source.maxTokens,
      input: Array.isArray(source.input) ? source.input : [],
      reasoning: source.reasoning,
      reasoningEfforts: Array.isArray(source.reasoningEfforts) ? source.reasoningEfforts : [],
    }
  }

  const modelRows = rows.map((row) => {
    const cells = cellsOf(row)
    const open = expanded.has(row.key)
    const official = byId.get(row.id)
    const verdictResult = sync.results[row.id]
    const verdict = verdictResult === undefined ? undefined : describeSync(verdictResult)
    // One dot carries the whole sync story: green = measured and usable,
    // orange = measured and dead/gated, red = never measured. The stored
    // verdict's status keeps the color honest across reloads; a verdict taken
    // THIS session is fresher than anything stored.
    const dotTone = verdict !== undefined
      ? (verdict.tone === 'ok' ? 'ok' : 'warn')
      : official?.synced === true
        ? (official.syncedStatus === undefined || official.syncedStatus === 'available' ? 'ok' : 'warn')
        : 'bad'
    const dotTitle = dotTone === 'ok'
      ? '已同步：可用'
      : dotTone === 'warn'
        ? `已同步：${verdict !== undefined ? verdict.headline : official.syncedStatus}`
        : '未同步'
    const rowField = (field) => `model.${row.id.length > 0 ? row.id : row.key}.${field}`
    const patchRow = (changes) => applyDirectory(patchDirectoryRow(draft, row, changes))
    const editable = writable
    return React.createElement('div', { className: 'ocg-model-entry', key: row.key, 'data-ocg-model': row.id },
      React.createElement('div', { className: 'ocg-model-row' },
        React.createElement('span', { className: 'ocg-model-idwrap' },
          React.createElement('span', {
            className: `ocg-dot ocg-dot--${dotTone}`,
            role: 'img',
            'aria-label': dotTitle,
            title: dotTitle,
            'data-ocg-dot': row.id,
          }),
          row.extra !== undefined
            ? React.createElement('input', {
              className: 'ocg-input',
              type: 'text',
              placeholder: '模型 ID',
              value: cells.id,
              disabled: !editable,
              'data-ocg-field': rowField('id'),
              onChange: (event) => patchRow({ id: event.target.value }),
            })
            : React.createElement('span', { className: 'ocg-model-name-cell', 'data-ocg-field': rowField('id') }, row.name !== row.id ? row.name : row.id),
        ),
        row.extra !== undefined
          ? React.createElement('input', {
            className: 'ocg-input',
            type: 'text',
            placeholder: '显示名称（可选）',
            value: cells.name ?? '',
            disabled: !editable,
            'data-ocg-field': rowField('name'),
            onChange: (event) => patchRow({ name: event.target.value }),
          })
          : React.createElement('span', { className: 'ocg-model-id-cell' }, row.name !== row.id ? row.id : ''),
        React.createElement('button', {
          type: 'button',
          className: 'ocg-icon',
          title: '容量与能力',
          'aria-expanded': open ? 'true' : 'false',
          'data-ocg-field': rowField('toggle'),
          onClick: () => toggleExpanded(row.key),
        }, React.createElement(IconChevron, { open })),
        React.createElement('button', {
          type: 'button',
          className: 'ocg-icon ocg-icon--danger',
          title: '停用这个模型',
          disabled: !editable,
          'data-ocg-field': rowField('remove'),
          onClick: () => commitModels(
            removeDirectoryRow(draft, row),
            row.advertised === true ? `已停用 ${row.id} 并保存。` : `已移除 ${row.id} 并保存。`,
          ),
        }, React.createElement(IconTrash)),
      ),
      // Capability facts appear ONLY after a sync has measured them. Before
      // that the row says so instead of showing the bundled snapshot's numbers:
      // a declared number and a measured one look identical once rendered, and
      // the whole point of the sync is that the operator can tell them apart.
      // A verdict taken THIS session already answers the question, so the
      // "not synced yet" hint must not contradict the verdict box below it.
      official?.synced === true
        ? CapabilityChips({ model: official })
        : verdictResult === undefined
          ? React.createElement('p', { className: 'ocg-unsynced', 'data-ocg-unsynced': String(row.id ?? '') }, SYNC_NOT_SYNCED)
          : null,
      // A usable verdict needs no box: the chips above already carry the facts
      // and the dot says "measured". Only a DEAD model gets a line — ONE line,
      // no box — because quietly keeping a delisted id enabled is exactly what
      // the sync exists to prevent, and the line names a replacement.
      verdict === undefined || verdict.tone === 'ok' ? null : (() => {
        const replacement = replacementSuggestions(rows, sync.results)[row.id]
        return React.createElement('p', {
          className: 'ocg-notice ocg-notice--error ocg-dead',
          'data-ocg-dead': row.id,
        },
          `${verdict.headline}：${verdict.detail}`,
          replacement === undefined ? null : `　建议换用 ${replacement} —— 该模型现在不可用。`,
        )
      })(),
      open ? React.createElement('div', { className: 'ocg-model-advanced' },
        React.createElement(SelectField, {
          label: 'API 协议', value: cells.api, options: SUPPORTED_PROTOCOLS, allowBlank: true, variant: 'model',
          blankLabel: `跟随规则${official?.protocol === undefined ? '' : `（当前 ${official.protocol}）`}`,
          disabled: !editable,
          field: rowField('api'),
          error: cellError(row, 'api'),
          onChange: (value) => patchRow({ api: value }),
        }),
        React.createElement(CapacityField, {
          label: '上下文窗口', value: cells.contextWindow, disabled: !editable,
          placeholder: capacityPlaceholder(official?.effective?.contextWindow, '默认'),
          field: rowField('contextWindow'),
          error: cellError(row, 'contextWindow'),
          onChange: (value) => patchRow({ contextWindow: value === '' ? undefined : value }),
        }),
        React.createElement(CapacityField, {
          label: '最大输出 token', value: cells.maxTokens, disabled: !editable,
          placeholder: capacityPlaceholder(official?.effective?.maxTokens, '默认'),
          field: rowField('maxTokens'),
          error: cellError(row, 'maxTokens'),
          onChange: (value) => patchRow({ maxTokens: value === '' ? undefined : value }),
        }),
        React.createElement(ChipField, {
          label: '输入模态（留空=用默认）', values: cells.input, options: CONFIGURABLE_INPUT_MODALITIES, disabled: !editable, wide: true,
          hint: modalityPlaceholder(official?.effective),
          field: rowField('input'),
          error: cellError(row, 'input'),
          onChange: (value) => patchRow({ input: value }),
        }),
        React.createElement(SwitchRow, {
          label: '断言该模型会思考（reasoning）', checked: cells.reasoning === true, disabled: !editable, variant: 'model',
          hint: `默认：${official?.effective?.reasoning === true ? '会思考' : '不思考'}`,
          field: rowField('reasoning'),
          onChange: (value) => patchRow({ reasoning: value }),
        }),
        React.createElement(ChipField, {
          label: 'reasoningEfforts（留空=默认档位）', values: cells.reasoningEfforts,
          options: CONFIGURABLE_THINKING_LEVELS, disabled: !editable, wide: true,
          hint: Array.isArray(official?.effective?.reasoningEfforts) && official.effective.reasoningEfforts.length > 0
            ? `默认：${official.effective.reasoningEfforts.join(' / ')}`
            : '默认：无（off 用“不思考”表达）',
          field: rowField('reasoningEfforts'),
          error: cellError(row, 'reasoningEfforts'),
          onChange: (value) => patchRow({ reasoningEfforts: value }),
        }),
      ) : null,
    )
  })

  // ── the subscription rows (0.8.2) ─────────────────────────────────────────
  // One row per subscription, TWO lines each: the first carries the radio for
  // "this one pays", the name, the badge and the two row actions; the second is
  // the balance — three meters, each with its reset time underneath. Clicking
  // the row SWITCHES to it — a settings write of its own (see `activate`); the
  // editor the chevron opens auto-saves (a key on blur, the rest debounced).
  // The split is not decoration: the name and three meters side by side is what
  // squeezed the name to a few characters, and a reset phrase has nowhere to go
  // on a single line.
  const usageById = new Map((usage.rows ?? []).map((entry) => [entry.id, entry]))
  const slots = subscriptionSlots(draft)
  /** The inline error for one subscription cell — host messages name the id,
   *  the client validator names the row position; both land on the same cell
   *  (the same double-spelling rule the model rows follow). */
  const subError = (row, index, field) => {
    const byIndex = errors[`subscriptions[${String(index)}].${field}`]
    if (byIndex !== undefined) return byIndex
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    return id.length > 0 ? errors[`subscriptions[${id}].${field}`] : undefined
  }
  const activePointer = draft.activeSubscription
  const subscriptionRows = (Array.isArray(draft.subscriptions) ? draft.subscriptions : [])
    // A row the operator took off the list is not rendered at all. The DEFAULT
    // row can only ever be hidden (the host synthesizes it), and the header
    // offers the way back.
    .map((row, index) => {
      if (row?.hidden === true) return null
      const open = expanded.has(`sub:${row.key}`)
    const view = usageById.get(row.isDefault === true ? DEFAULT_SUB_ID : row.id.trim())
    const isActive = activePointer === row.key || (row.id !== '' && row.id === activePointer)
    const cells = balanceCells(view)
    const editable = writable
    const patchRow = (changes) => applyDirectory((state) => patchSubRow(state, row.key, changes))
    const name = row.label.trim().length > 0
      ? row.label.trim()
      : (row.isDefault === true ? DEFAULT_SUB_LABEL : row.key)
    const slot = slots.get(row.key) ?? ''
    const configured = view?.configured
    const staged = typeof row.apiKey === 'string' && row.apiKey.trim().length > 0
    // Three meters ALWAYS: a window the gateway has not answered for renders an
    // EMPTY track and an em dash, so the columns line up across rows and "not
    // measured" can never be mistaken for "0% used". The ROW always uses the
    // short window name ('5h'), whatever shape the cell arrived in — the long
    // one ('5 小时') is four times wider than the label column and used to run
    // straight over the track.
    const meters = USAGE_WINDOW_KEYS.map((window) => {
      const found = cells.find((cell) => cell.window === window)
      return {
        window,
        label: USAGE_WINDOW_LABELS[window] ?? window,
        short: USAGE_WINDOW_SHORT[window] ?? window,
        percent: found?.percent,
        status: found?.status,
        resetsAt: found?.resetsAt,
        tone: found?.tone ?? 'none',
      }
    })
    return React.createElement('div', {
      className: isActive ? 'ocg-sub ocg-sub--active' : 'ocg-sub',
      key: row.key,
      'data-ocg-sub': row.key,
    },
      React.createElement('div', {
        className: 'ocg-sub-main',
        role: 'button',
        tabIndex: 0,
        title: isActive ? '当前订阅：所有请求都用它' : SUBS_ACTIVATE_HINT,
        'data-ocg-field': `subscriptions[${String(index)}].activate`,
        'data-ocg-sub-active': isActive ? '1' : '0',
        onClick: () => { if (!isActive) activate(row.key) },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (!isActive) activate(row.key)
          }
        },
      },
        React.createElement('span', {
          className: isActive ? 'ocg-radio ocg-radio--on' : 'ocg-radio',
          'aria-hidden': 'true',
          'data-ocg-sub-dot': row.key,
        }),
        React.createElement('span', { className: 'ocg-sub-name-wrap' },
          React.createElement('span', { className: 'ocg-sub-name' }, name),
          isActive ? React.createElement('span', { className: 'ocg-pill ocg-pill--brand' }, SUBS_ACTIVE_BADGE) : null,
        ),
        React.createElement('button', {
          type: 'button',
          className: 'ocg-icon',
          title: open ? '收起' : SUBS_ROW_EDIT,
          'aria-expanded': open ? 'true' : 'false',
          'data-ocg-field': `subscriptions[${String(index)}].toggle`,
          onClick: (event) => { event?.stopPropagation?.(); toggleExpanded(`sub:${row.key}`) },
        }, React.createElement(IconChevron, { open })),
        // EVERY row carries the trash; the one that PAYS cannot be removed, so
        // its button is disabled with the reason on hover. That is the whole
        // rule: "delete anything, except the subscription you are currently
        // spending" — with a single subscription, that one is active, so there
        // is nothing to remove anywhere.
        React.createElement('button', {
          type: 'button',
          className: 'ocg-icon ocg-icon--danger',
          title: isActive ? SUBS_ROW_LOCKED : SUBS_ROW_REMOVE,
          disabled: isActive || !editable,
          'data-ocg-field': `subscriptions[${String(index)}].remove`,
          'data-ocg-remove-locked': isActive ? '1' : '0',
          onClick: (event) => { event?.stopPropagation?.(); applyDirectory((state) => removeSubRow(state, row.key), { immediate: true }) },
        }, React.createElement(IconTrash)),
        // Line two, under the name (`grid-area` in the stylesheet places it): the
        // balance of THIS subscription, one meter per window, so the row answers
        // "who pays" and "how much is left" without being read twice.
        React.createElement('div', { className: 'ocg-meters', 'data-ocg-balance': row.key },
          meters.map((cell) => React.createElement(Meter, { key: cell.window, cell }))),
      ),
      open ? React.createElement('div', { className: 'ocg-sub-body' },
        React.createElement('div', { className: 'ocg-sub-fields' },
          React.createElement(TextField, {
            label: SUBS_NAME_LABEL,
            value: row.isDefault === true ? draft.displayName : row.label,
            disabled: !editable,
            variant: 'model',
            placeholder: row.isDefault === true ? DEFAULT_SUB_LABEL : SUBS_NAME_PLACEHOLDER,
            field: `subscriptions[${String(index)}].label`,
            error: subError(row, index, 'label'),
            onChange: (value) => (row.isDefault === true ? patch('displayName', value) : patchRow({ label: value })),
          }),
          React.createElement(TextField, {
            label: SUBS_KEY_LABEL,
            value: row.apiKey,
            type: 'password',
            disabled: !editable,
            variant: 'model',
            placeholder: SUBS_KEY_PLACEHOLDER,
            field: `subscriptions[${String(index)}].apiKey`,
            error: subError(row, index, 'apiKey'),
            onChange: (value) => patchRow({ apiKey: value }),
            // A secret is never written character by character: leaving the
            // field (or pressing Enter) is what stores it, immediately.
            onCommit: () => { void storeRowCredential(row.key) },
          }),
        ),
        React.createElement('div', { className: 'ocg-sub-meta' },
          React.createElement('span', {
            className: 'ocg-sub-slot',
            'data-ocg-field': `subscriptions[${String(index)}].slot`,
            title: slot.length === 0
              ? '先给它一个名字；密钥会存进以名字命名的凭据槽位'
              : `这条订阅自己的凭据槽位（.credentials.yaml）：${slot}。槽位跟着「名字」走，`
                + '旧拼写的槽位会作为兜底保留：改名后插件先把旧槽位里的 key 搬过来，所以改名不丢密钥。',
          }, slot.length === 0 ? `${SUBS_KEY_SLOT} —` : `${SUBS_KEY_SLOT} ${slot}`),
          React.createElement(CredentialPill, { view }),
          staged ? React.createElement('span', { className: 'ocg-pill ocg-pill--dim' }, '新密钥待写入') : null,
          view?.usage?.error === undefined
            ? null
            : React.createElement('span', { className: 'ocg-pill ocg-pill--bad', title: `余额查询失败：${view.usage.error}` }, '余额查询失败'),
          configured === true
            ? React.createElement('button', {
              type: 'button',
              className: 'ocg-link ocg-link--danger ocg-sub-meta-end',
              'data-ocg-field': `subscriptions[${String(index)}].clearCredential`,
              disabled: !editable,
              onClick: () => clearCredential(row),
            }, '清除已存密钥')
            : null,
        ),
      ) : null,
    )
    })
    .filter((entry) => entry !== null)

  const visibleCandidates = (() => {
    const all = picker.candidates ?? []
    const query = picker.query.trim().toLowerCase()
    if (query.length === 0) return all
    return all.filter((candidate) => candidate.id.toLowerCase().includes(query)
      || (typeof candidate.name === 'string' && candidate.name.toLowerCase().includes(query)))
  })()
  const allVisiblePicked = visibleCandidates.length > 0
    && visibleCandidates.every((candidate) => (picker.wanted ?? []).includes(candidate.id))

  const pickerDialog = picker.candidates === undefined ? null : React.createElement('div', { className: 'ocg-dialog' },
    React.createElement('div', { className: 'ocg-dialog-body' },
      React.createElement('div', { className: 'ocg-dialog-title' }, FETCH_TITLE),
      React.createElement('p', { className: 'ocg-hint' }, FETCH_DESCRIPTION),
      React.createElement('div', { className: 'ocg-candidate-toolbar' },
        React.createElement('input', {
          className: 'ocg-input',
          type: 'search',
          placeholder: FETCH_SEARCH,
          value: picker.query,
          'data-ocg-field': 'fetch.search',
          onChange: (event) => setPicker((state) => ({ ...state, query: event.target.value })),
        }),
        React.createElement('button', {
          type: 'button',
          className: 'ocg-link',
          disabled: visibleCandidates.length === 0,
          'data-ocg-field': 'fetch.toggleAll',
          onClick: () => setPicker((state) => {
            const current = state.wanted ?? []
            if (visibleCandidates.every((candidate) => current.includes(candidate.id))) {
              return { ...state, wanted: current.filter((id) => !visibleCandidates.some((candidate) => candidate.id === id)) }
            }
            const next = [...current]
            for (const candidate of visibleCandidates) if (!next.includes(candidate.id)) next.push(candidate.id)
            return { ...state, wanted: next }
          }),
        }, allVisiblePicked ? FETCH_DESELECT_ALL : FETCH_SELECT_ALL),
      ),
      picker.error === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, picker.error),
      picker.error !== undefined ? null : visibleCandidates.length === 0
        ? React.createElement('p', { className: 'ocg-candidate-empty' }, FETCH_NO_MATCHES)
        : React.createElement('div', { className: 'ocg-candidate-list' }, visibleCandidates.map((candidate) => {
          const on = (picker.wanted ?? []).includes(candidate.id)
          return React.createElement('label', {
            className: on ? 'ocg-candidate ocg-candidate--on' : 'ocg-candidate',
            key: candidate.id,
          },
            React.createElement('span', { className: 'ocg-candidate-label' },
              React.createElement('input', {
                type: 'checkbox',
                checked: on,
                'data-ocg-field': `candidate.${candidate.id}`,
                onChange: () => setPicker((state) => {
                  const current = state.wanted ?? []
                  return {
                    ...state,
                    wanted: current.includes(candidate.id)
                      ? current.filter((id) => id !== candidate.id)
                      : [...current, candidate.id],
                  }
                }),
              }),
              React.createElement('span', { className: 'ocg-candidate-id' }, candidate.id),
              candidate.name === candidate.id ? null : React.createElement('span', { className: 'ocg-candidate-name' }, candidate.name),
            ),
          )
        })),
      React.createElement('div', { className: 'ocg-dialog-foot' },
        React.createElement('button', {
          type: 'button',
          className: 'ocg-btn ocg-btn--secondary',
          'data-ocg-field': 'fetch.cancel',
          onClick: () => setPicker({ busy: false, candidates: undefined, error: undefined, wanted: [], query: '' }),
        }, '取消'),
        React.createElement('button', {
          type: 'button',
          className: 'ocg-btn ocg-btn--primary',
          disabled: busy,
          'data-ocg-field': 'fetch.apply',
          onClick: () => applySelection(),
        }, FETCH_APPLY),
      ),
    ),
  )

  const diagnosticsBody = diagnostics.view === undefined ? null : React.createElement('div', { className: 'ocg-editor' },
    React.createElement('p', { className: 'ocg-hint' }, '数据来自宿主插件自己的日志环与健康分类（不新开日志来源）；载荷里没有凭据值。'),
    React.createElement('table', { className: 'ocg-table' },
      React.createElement('tbody', null,
        React.createElement('tr', null,
          React.createElement('th', null, '下一次请求用'),
          React.createElement('td', null,
            `${String(diagnostics.view.connection.baseURL)} · 凭据引用 ${String(diagnostics.view.connection.apiKeyEnv)}（只是名字，不是值）`
            + (diagnostics.view.connection.legacyInlineKey === true ? ' · 仍有旧版明文 key（等待迁移）' : '')),
        ),
        React.createElement('tr', null,
          React.createElement('th', null, '模型列表'),
          React.createElement('td', null, `status=${String(diagnostics.view.catalogue.status)} · discovered=${String(diagnostics.view.catalogue.discovered)} · effective=${String(diagnostics.view.catalogue.effective)}${diagnostics.view.catalogue.lastError === undefined ? '' : ` · lastError=${String(diagnostics.view.catalogue.lastError)}`}`),
        ),
        React.createElement('tr', null,
          React.createElement('th', null, '官方声明数据'),
          React.createElement('td', null, officialSourceText(diagnostics.view.official)),
        ),
        React.createElement('tr', null,
          React.createElement('th', null, '被遮蔽的旧别名'),
          React.createElement('td', null, (diagnostics.view.configuration.models?.protocolOverridesShadowed ?? []).join(', ') || '（无）'),
        ),
        (diagnostics.view.subscriptions ?? []).length === 0 ? null : React.createElement('tr', null,
          React.createElement('th', null, '订阅'),
          React.createElement('td', null, diagnostics.view.subscriptions
            .map((entry) => `${String(entry.label)}(${String(entry.id)}): ${String(entry.state)}${entry.detail === undefined ? '' : `（${String(entry.detail)}）`}`)
            .join(' | ')),
        ),
        React.createElement('tr', null,
          React.createElement('th', null, '生效 id 与来源'),
          React.createElement('td', null, (diagnostics.view.catalogue.sources ?? [])
            .map((source) => `${String(source.id)}(${String(source.source)})`)
            .join('、') || '（无）'),
        ),
      ),
    ),
    diagnostics.view.summaryLines.length === 0 ? null : React.createElement('p', { className: 'ocg-hint' }, diagnostics.view.summaryLines.join('\n')),
    React.createElement('p', { className: 'ocg-subhead' }, `端点健康（${String(diagnostics.view.health.length)} 行）`),
    diagnostics.view.health.length === 0
      ? React.createElement('p', { className: 'ocg-hint' }, '还没有健康记录。')
      : React.createElement('table', { className: 'ocg-table' },
        React.createElement('thead', null, React.createElement('tr', null,
          React.createElement('th', null, 'model'), React.createElement('th', null, 'category'),
          React.createElement('th', null, 'protocol'), React.createElement('th', null, 'status'), React.createElement('th', null, 'action'),
        )),
        React.createElement('tbody', null, diagnostics.view.health.map((row, index) => React.createElement('tr', { key: `${String(row.modelId)}-${String(index)}` },
          React.createElement('td', null, String(row.modelId)),
          React.createElement('td', null, String(row.category)),
          React.createElement('td', null, String(row.protocol ?? '')),
          React.createElement('td', null, row.status === undefined ? '' : String(row.status)),
          React.createElement('td', null, String(row.action ?? '')),
        ))),
      ),
    React.createElement('p', { className: 'ocg-subhead' }, `日志环（${String(diagnostics.view.log.length)} 行，warn ${String(diagnostics.view.warnings.length)} 条）`),
    React.createElement('div', { className: 'ocg-log' }, diagnostics.view.log.length === 0
      ? '（空）'
      : diagnostics.view.log.map((line, index) => `${new Date(line.at ?? 0).toISOString()} [${String(line.level)}] ${String(line.message)}`).join('\n')),
  )

  /**
   * Whether the subscription that pays right now has a key stored (`undefined`
   * while the credential seam cannot say). This is the one fact worth a dot in
   * the card head: a keyless active row fails every request at the gateway's
   * door, and nothing else on this page can tell the operator that.
   */
  const activeRow = (Array.isArray(draft.subscriptions) ? draft.subscriptions : [])
    .find((row) => row.key === draft.activeSubscription || (row.id !== '' && row.id === draft.activeSubscription))
  const activeConfigured = (() => {
    const target = activeRow?.isDefault === true ? DEFAULT_SUB_ID : (activeRow?.id ?? '')
    return (usage.rows ?? []).find((entry) => entry.id === target)?.configured
  })()

  /**
   * The name in the card head is the name of the subscription that PAYS.
   *
   * It used to be the top-level `displayName` — which is only the DEFAULT row's
   * name — so switching to another subscription left the head showing the wrong
   * account. A page whose header contradicts its own 「当前」 row is worse than
   * no header at all.
   */
  const activeName = (() => {
    const label = activeRow?.isDefault === true ? draft.displayName : activeRow?.label
    return typeof label === 'string' && label.trim().length > 0 ? label.trim() : 'OpenCode Go'
  })()

  /**
   * The subscription list — the whole top of the page.
   *
   * ONE header line and one line per row: the explanation lives in the title
   * tooltip, because the only decisions here are "which one pays" (click a row)
   * and "what is this key's name" (open the row).
   */
  const subscriptionsSection = React.createElement('section', { className: 'ocg-subs', 'data-ocg-section': 'subscriptions' },
    React.createElement('div', { className: 'ocg-subs-head' },
      React.createElement('span', { className: 'ocg-subs-title', title: SUBS_DESCRIPTION, 'data-ocg-field': 'subs.title' }, SUBS_TITLE),
      React.createElement('span', { className: 'ocg-subs-count', title: `${String(subscriptionRows.length)} 条订阅`, 'data-ocg-field': 'subs.count' }, String(subscriptionRows.length)),
      React.createElement('span', { className: 'ocg-subs-note' }, SUBS_NOTE),
      React.createElement('span', { className: 'ocg-subs-actions' },
        // The default row can be taken off the list (it is synthesized from the
        // top-level fields, so hiding is the only way to "delete" it) — this is
        // the way back, so that click is not a one-way door.
        defaultRowHidden(draft)
          ? React.createElement('button', {
            type: 'button',
            className: 'ocg-link',
            title: '把系统默认订阅（顶层 apiKeyEnv 那个槽位）放回列表',
            'data-ocg-field': 'action.restoreDefaultSub',
            disabled: !writable,
            onClick: () => applyDirectory(restoreDefaultRow, { immediate: true }),
          }, SUBS_RESTORE_DEFAULT)
          : null,
        React.createElement('button', {
          type: 'button',
          className: 'ocg-link',
          title: '逐个问一遍网关，拿回每个 key 的余额',
          'data-ocg-field': 'action.refreshUsage',
          disabled: usage.busy,
          onClick: () => void loadUsage(true),
        }, usage.busy ? SUBS_REFRESH_BUSY : SUBS_REFRESH_BUTTON),
        React.createElement('button', {
          type: 'button',
          className: 'ocg-btn ocg-btn--secondary ocg-btn--compact',
          title: SUBS_ADD_HINT,
          'data-ocg-field': 'action.addSub',
          disabled: !writable,
          onClick: () => applyDirectory(addSubscriptionRow, { immediate: true }),
        }, SUBS_ADD_BUTTON),
      ),
    ),
    usage.error === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, `余额查询出错：${usage.error}`),
    subscriptionRows.length === 0
      ? React.createElement('p', { className: 'ocg-model-empty' }, '没有订阅行（不应该发生：默认订阅总在）。点「重新载入」看看。')
      : React.createElement('div', { className: 'ocg-subs-list' }, subscriptionRows),
  )

  return React.createElement('div', { className: 'ocg-section' },
    React.createElement('style', null, SECTION_CSS),
    banner === undefined ? null : React.createElement('p', { className: `ocg-notice ocg-notice--${banner.kind === 'ok' ? 'ok' : 'error'}` }, banner.text),
    conflict === true
      ? React.createElement('div', null, React.createElement('button', { type: 'button', className: 'ocg-btn ocg-btn--secondary', onClick: () => void load() }, '重新载入最新设置'))
      : null,
    legacyKey === true ? React.createElement('p', { className: 'ocg-notice ocg-notice--warn' }, LEGACY_API_KEY_WARNING) : null,
    errors.models === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, errors.models),
    errors.modelsExtra === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, errors.modelsExtra),
    errors.modelsOverrides === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, errors.modelsOverrides),
    // The section-level refusals have no control of their own to sit beside, and
    // with auto-save a refusal nobody renders is a form that silently stops
    // writing. They are shown HERE, at the top, where the stalled write is.
    errors.subscriptions === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, errors.subscriptions),
    errors.activeSubscription === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, errors.activeSubscription),
    errors.apiKeyEnv === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, errors.apiKeyEnv),

    React.createElement('h2', { className: 'ocg-title' }, 'OpenCode Go'),
    React.createElement('p', { className: 'ocg-intro' }, modelSourceLine()),

    React.createElement('div', { className: 'ocg-card' },
      React.createElement('div', { className: 'ocg-card-head' },
        React.createElement('span', { className: 'ocg-identity' },
          // The name of the subscription that PAYS, so the head can never
          // contradict the 「当前」 row underneath it.
          React.createElement('span', { className: 'ocg-name', 'data-ocg-field': 'active.name' }, activeName),
          // The dot answers "does the subscription that pays right now have a
          // key at all" — the one thing about the active row that makes every
          // request fail before it reaches the gateway.
          activeConfigured === undefined ? null
            : activeConfigured === true
              ? React.createElement('span', {
                className: 'ocg-dot ocg-dot--ok',
                role: 'img',
                'aria-label': '当前订阅的密钥已配置',
                title: '当前订阅的密钥已配置',
              })
              : React.createElement('span', {
                className: 'ocg-dot ocg-dot--bad',
                role: 'img',
                'aria-label': '当前订阅没有密钥',
                title: '当前订阅没有密钥：展开这一行填入 API 密钥（离开输入框即写入）',
              }),
        ),
        // No buttons here: there is no 保存 any more (a change IS the commit), and
        // a manual reload is the recovery act for a multi-tab conflict — which
        // raises its own button when it happens, rather than sitting in the head
        // as a permanently tempting way to throw away local state.
        busy === true ? React.createElement('span', { className: 'ocg-subs-note', 'data-ocg-field': 'write.state' }, '写入中…') : null,
      ),
      React.createElement('div', { className: 'ocg-editor' },
        // The subscription list IS the top of this page (0.8.2): the single
        // top-level API-key field it replaced could only ever describe one key,
        // and the route now has as many as the operator wants.
        subscriptionsSection,
        React.createElement('details', { className: 'ocg-details' },
          React.createElement('summary', { className: 'ocg-details-summary' }, '自定义设置'),
          React.createElement('div', { className: 'ocg-details-body' },
            React.createElement(TextField, {
              label: 'API 地址', value: draft.baseURL, disabled: !writable,
              field: 'baseURL',
              hint: '网关基址，含 /v1。',
              error: errors.baseURL,
              onChange: (value) => patch('baseURL', value),
            }),
            React.createElement(SwitchRow, {
              label: 'sessionHeaderEnabled — 发送会话头', checked: draft.sessionHeaderEnabled, disabled: !writable,
              field: 'sessionHeaderEnabled',
              hint: '中继在没有会话头时回 400 MissingSessionID，所以默认开。',
              onChange: (value) => patch('sessionHeaderEnabled', value),
            }),
            React.createElement(TextField, {
              label: 'sessionHeader', value: draft.sessionHeader, disabled: !writable || draft.sessionHeaderEnabled === false,
              field: 'sessionHeader',
              hint: SESSION_HEADER_HINT,
              error: errors.sessionHeader,
              onChange: (value) => patch('sessionHeader', value),
            }),
            React.createElement(SelectField, {
              label: 'sessionHeaderMode', value: draft.sessionHeaderMode, options: SESSION_HEADER_MODES,
              field: 'sessionHeaderMode',
              disabled: !writable || draft.sessionHeaderEnabled === false,
              hint: 'session-id = 转发宿主会话 id；uuid = 每个会话一个不透明值。',
              error: errors.sessionHeaderMode,
              onChange: (value) => patch('sessionHeaderMode', value),
            }),
          ),
        ),
        React.createElement('section', { className: 'ocg-catalog' },
          React.createElement('div', { className: 'ocg-catalog-head' },
            React.createElement('div', { className: 'ocg-catalog-heading' },
              React.createElement('span', { className: 'ocg-catalog-title' }, `模型（已启用 ${String(enabledCount)} 个）`),
              React.createElement('span', { className: 'ocg-catalog-meta', title: SYNC_HINT }, SYNC_NOTE),
            ),
            React.createElement('span', { className: 'ocg-catalog-actions' },
              React.createElement('button', {
                type: 'button',
                className: 'ocg-link',
                'data-ocg-field': 'action.fetch',
                disabled: picker.busy,
                onClick: () => openPicker(),
              }, picker.busy ? '正在询问提供方…' : '获取可用模型'),
              React.createElement('button', {
                type: 'button',
                className: 'ocg-link',
                'data-ocg-field': 'action.sync',
                disabled: sync.busy || enabledCount === 0,
                onClick: () => { void runSync() },
              }, sync.busy ? SYNC_BUSY : SYNC_BUTTON),
              sync.busy !== true ? null : React.createElement('button', {
                type: 'button',
                className: 'ocg-link',
                'data-ocg-field': 'action.syncStop',
                onClick: () => {
                  syncStop.current = true
                  // Abort the request in flight; the host aborts its own upstream
                  // work when this connection closes.
                  syncAbort.current?.abort()
                },
              }, SYNC_STOP),
              React.createElement('button', {
                type: 'button',
                className: 'ocg-link',
                'data-ocg-field': 'action.toggleAdd',
                disabled: !writable,
                onClick: () => setAdder((state) => ({ ...state, open: !state.open })),
              }, ADD_MODEL_LABEL),
            ),
          ),
          catalogueError === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, `模型列表读取失败：${catalogueError}`),
          refreshNote === undefined ? null : React.createElement('p', { className: 'ocg-hint' }, `向网关刷新模型列表时出错：${refreshNote}`),
          syncProgressText(sync, syncClock) === undefined ? null : React.createElement('p', {
            className: 'ocg-hint', 'data-ocg-sync-progress': '1',
          }, syncProgressText(sync, syncClock)),
          sync.error === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, `同步出错：${sync.error}`),
          sync.stopped === true ? React.createElement('p', { className: 'ocg-hint' }, '已停止；已经同步过的模型已经保存。') : null,
          // A discovery failure reads behind the closed dialog only: once the
          // dialog is open it carries its own notice, so the text never doubles.
          picker.error === undefined || picker.candidates !== undefined
            ? null
            : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, picker.error),
          adder.open ? React.createElement('div', { className: 'ocg-field' },
            React.createElement('div', { className: 'ocg-adder' },
              React.createElement('input', {
                className: 'ocg-input',
                type: 'text',
                placeholder: ADD_MODEL_LABEL,
                value: adder.id,
                disabled: busy,
                'data-ocg-field': 'add.model.id',
                onChange: (event) => setAdder((state) => ({ ...state, id: event.target.value })),
              }),
              React.createElement('button', {
                type: 'button',
                className: 'ocg-add-btn',
                disabled: adder.id.trim().length === 0,
                'data-ocg-field': 'action.addModel',
                onClick: () => addModel(),
              }, ADD_MODEL_BUTTON),
            ),
            React.createElement('span', { className: 'ocg-hint ocg-add-hint' }, ADD_MODEL_HINT),
          ) : null,
          rows.length === 0
            ? React.createElement('p', { className: 'ocg-model-empty' }, catalogue === undefined ? '正在读取模型列表…' : '还没有启用任何模型。点“获取可用模型”挑几个。')
            : React.createElement('div', { className: 'ocg-model-list' }, modelRows),
        ),
      ),
    ),

    React.createElement('div', { className: 'ocg-card' },
      React.createElement('div', { className: 'ocg-card-head' },
        React.createElement('span', { className: 'ocg-identity' },
          React.createElement('span', { className: 'ocg-name' }, '诊断'),
        ),
        React.createElement('span', { className: 'ocg-head-actions' },
          React.createElement('button', {
            type: 'button',
            className: 'ocg-btn ocg-btn--secondary',
            'data-ocg-field': 'action.diagnostics',
            disabled: diagnostics.busy,
            onClick: () => showDiagnostics(),
          }, diagnostics.busy ? '读取中…' : (diagnostics.open ? '重新读取诊断' : '查看诊断')),
        ),
      ),
      diagnostics.error === undefined ? null : React.createElement('p', { className: 'ocg-notice ocg-notice--error' }, diagnostics.error),
      diagnosticsBody,
    ),
    pickerDialog,
  )
}

/**
 * Locate this plugin's namespace view in a `settings.describe()` answer or in
 * the single-namespace reply of a mutation (same shape, one-element list).
 */
function namespaceViewOf(describe) {
  const namespaces = Array.isArray(describe?.namespaces) ? describe.namespaces : []
  return namespaces.find((entry) => entry?.ns === SETTINGS_NS)
}
