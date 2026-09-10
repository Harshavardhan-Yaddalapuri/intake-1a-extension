/**
 * Probe Runner: empirical in-browser Rung 1 discovery driver.
 *
 * Implements Rung 1 probe execution (proposal-b section 4, rung 1):
 *   1. Palette place-and-inspect per candidate control: converts arbitrary
 *      naming into structural truth (combobox vs radiogroup vs checkbox vs
 *      listbox).
 *   2. Commit probe: clicks candidate persist buttons and checks whether
 *      dirty banners clear or saved badges appear (distinguishing real Save
 *      from Save As Template / Bank It).
 *   3. Coded values append-vs-replace probe.
 *
 * HARD WALLS:
 *   - ProbeRunner uses TabDriver to ACT and PERCEIVE.
 *   - Decision logic relies strictly on structural observation & diffs.
 *   - NEVER uses mock debug hooks (__readState, __groundTruth).
 */

import { CANONICAL_TYPES } from '../shared/contract';
import type {
  BindingRecord,
  CanonicalType,
  ContractOpId,
} from '../shared/contract';
import type { Observation } from '../perceive/core';
import { diffObservations } from '../perceive/core';
import {
  inspectPlacedControl,
  classifyTypeFromProbe,
  makeTypeBinding,
  analyzeCommit,
  analyzeAppendReplace,
  type ProbeResult,
  type CommitProbeResult,
} from '../bind/rung1';
import { TabDriver } from './tab-driver';
import {
  enumerateActionable,
  enumerateActions,
  rankCandidates,
  largestControlCluster,
  matchesHintExact,
  matchesHintWord,
  matchesHintLoose,
} from '../bind/ranking';
import { rankCommitCandidates, bindFieldPaletteOpen } from '../bind/rung0';

export interface DiscoveredPaletteItem {
  name: string;
  handle: string;
  probe: ProbeResult;
  matchedTypes: CanonicalType[];
}


/** True when a place-and-inspect result cannot yet distinguish choice types.
 *
 *  An empty radio/multi_select renders no options; the property panel's
 *  Required checkbox (often unnamed) then wins the diff and looks like a
 *  multi_select. Deepening by adding values reveals the real control.
 */
function needsChoiceDeepen(probe: ProbeResult): boolean {
  // Only deepen when the panel claims this is a choice control. Deepening a
  // plain text/date tile would click "+ Add Value" that does not exist.
  if (!probe.hasOptionsEditor) return false;
  if (probe.observedOptions.length > 0) return false;
  // Already a realised choice — nothing further to reveal.
  if (
    probe.observedRole === 'radiogroup' ||
    probe.observedRole === 'radio' ||
    probe.observedRole === 'listbox' ||
    probe.observedRole === 'combobox'
  ) {
    return false;
  }
  // Empty choice: canvas has not realised options yet. Include textbox /
  // checkbox / button / generic / none — historically the panel Label was
  // misread as the placed control (role=textbox) and deepen never ran.
  return true;
}


/** Order coded_values-ranked panel actions for empty-choice deepen.
 *
 *  Bulk paste-apply buttons outrank row-add buttons on raw lexical score, but
 *  they are no-ops when the paste box is empty. Prefer add-row first so deepen
 *  actually materialises options (and thus radio vs dropdown structure).
 */
export function orderChoiceDeepenCandidates<T extends { name: string }>(
  ranked: readonly T[],
): T[] {
  const isPasteApply = (name: string) => {
    const n = name.toLowerCase();
    return (n.includes('apply') || n.includes('append')) && n.includes('paste');
  };
  const isAddRow = (name: string) => {
    const n = name.toLowerCase();
    return n.includes('add') && (
      n.includes('value') || n.includes('choice') || n.includes('option') ||
      n.includes('item') || n.includes('row')
    );
  };
  return [
    ...ranked.filter((r) => isAddRow(r.name)),
    ...ranked.filter((r) => !isAddRow(r.name) && !isPasteApply(r.name)),
    ...ranked.filter((r) => isPasteApply(r.name)),
  ];
}


/**
 * Palette probes must not leave the designer. On env-swapped-controls the
 * largest control cluster includes the builder chrome ("<- Screening", Lock,
 * Deploy); clicking the back control exits the builder and every later tile
 * probe sees the visit screen, so date (and most types) stay unbound.
 */

/** Panel actions eligible for empty-choice deepen (added OR changed handles). */
export function choiceDeepenPanelActions(
  beforePlace: Observation,
  afterPlace: Observation,
): ReturnType<typeof enumerateActions> {
  const diff = diffObservations(beforePlace, afterPlace);
  const panelHandles = new Set([...diff.added, ...diff.changed]);
  return enumerateActions(afterPlace).filter((e) => panelHandles.has(e.handle));
}

export function isSafePaletteProbeCandidate(name: string): boolean {
  const n = (name || '').trim().toLowerCase();
  // Icon-only library tiles (FormCraft calculated/time/datetime) have empty
  // accessible names. Still probe them — place-and-inspect is the adjudicator.
  // Named dangerous chrome is rejected below.
  if (!n) return true;
  if (n.startsWith('<-') || n.startsWith('←')) return false;
  if (matchesHintWord(n, 'ascend')) return false;
  // Persist / preview / deploy chrome — placing is not their job. Clicking one
  // while the working copy is dirty commits, previews or discards it, and
  // every probe after that reads a surface the agent did not mean to be on.
  // Matched EXACTLY, not loosely: a tile legitimately named "Save Point" is a
  // field, and excluding it would cost a field the brief penalises heavily.
  if (matchesHintExact(n, 'non_palette_action', 'chrome')) return false;
  return true;
}

/** Stepper control that reveals the next property (FormCraft wizard). */
export function findWizardAdvanceControl(obs: Observation): { name: string; handle: string } | null {
  const ranked = rankCandidates(enumerateActions(obs), { hint: 'wizard_advance' });
  const hit = ranked.find((r) => r.signals.some((s) => s.name === 'lexical'));
  return hit ? { name: hit.el.name, handle: hit.el.handle } : null;
}

/** Stepper control that returns to the previous property (FormCraft wizard). */
export function findWizardBackControl(obs: Observation): { name: string; handle: string } | null {
  const ranked = rankCandidates(enumerateActions(obs), { hint: 'wizard_back' });
  // Prefer a short wizard Back over breadcrumb ascend ("<- Screening").
  const hit = ranked.find((r) => {
    const n = (r.el.name || '').trim();
    if (!r.signals.some((s) => s.name === 'lexical' || s.name === 'lexical-exact')) return false;
    if (!matchesHintWord(n, 'wizard_back')) return false;
    // Breadcrumbs name the parent visit/form and are longer than stepper chrome.
    return n.length <= 16;
  });
  return hit ? { name: hit.el.name, handle: hit.el.handle } : null;
}

/** Delete/remove control for a selected canvas tile. Rosetta: "Delete Element";
 *  swapped: "Delete Node". Never Back/Cancel. */
export function findProbeDeleteAction(obs: Observation): { name: string; handle: string } | null {
  const del = enumerateActions(obs).find((e) => {
    const n = (e.name || '').trim().toLowerCase();
    if (!n) return false;
    // "Delete Element" / "Delete Node" / "Remove Field" — a delete verb applied
    // to a control noun — or a bare delete verb when the panel names no object.
    if (matchesHintWord(n, 'delete_element')) {
      return matchesHintWord(n, 'palette') || matchesHintExact(n, 'delete_element')
        || n.split(' ').length <= 2;
    }
    return false;
  });
  return del ? { name: del.name, handle: del.handle } : null;
}

/**
 * Click target that re-selects the just-placed probe tile so Delete Element /
 * Delete Node is enabled. Prefer a named canvas control that appeared since
 * beforePlace; fall back to any added actionable control.
 */
export function findPlacedProbeSelectTarget(
  beforePlace: Observation,
  afterPlace: Observation,
): { name: string; handle: string } | null {
  const diff = diffObservations(beforePlace, afterPlace);
  const added = new Set(diff.added);

  const isDeleteChrome = (n: string) => matchesHintWord(n, 'delete_element');

  const isNavOrCreate = (n: string) =>
    n.startsWith('<-') || n.startsWith('+')
    || matchesHintWord(n, 'ascend') || matchesHintWord(n, 'chrome');

  // Canvas previews are VALUE_ROLES (textbox/…) which enumerateActionable
  // excludes — look at obs.elements directly. Never pick Delete Element/Node
  // (it is in diff.added when the tile is selected).
  const prefer = new Set([
    'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio',
    'radiogroup', 'spinbutton', 'switch',
  ]);

  const usable = (e: { name: string; role: string; handle: string }) => {
    const n = (e.name || '').trim().toLowerCase();
    if (!n || isDeleteChrome(n) || isNavOrCreate(n)) return false;
    if (n === 'filter...' || n.includes('filter')) return false;
    // Panel fields, not the canvas tile.
    if (matchesHintExact(n, 'panel_field')) {
      return false;
    }
    if (prefer.has(e.role)) return true;
    // Boolean previews only expose Yes/No (True/False) buttons — no textbox.
    if (e.role === 'button' && /^(yes|no|true|false)$/.test(n)) return true;
    return false;
  };

  const beforeHandles = new Set(beforePlace.elements.map((e) => e.handle));

  let pool = afterPlace.elements.filter((e) => added.has(e.handle) && usable(e));

  // After deselect, panel chrome leaves the diff; the canvas preview remains.
  // Restrict to handles that were NOT present before the place. Falling back
  // to every usable() control on the page (v8) let removePlacedProbe re-select
  // and Delete already-built IR fields — e.g. Subject Initials — while probing
  // Beam Pick mid-Demographics, emptying the form and collapsing the live
  // swapped score from 19.4% back to 0.37%.
  if (pool.length === 0) {
    pool = afterPlace.elements.filter(
      (e) => usable(e) && !beforeHandles.has(e.handle),
    );
  }

  // Empty choice tiles (no values yet) render no textbox/radio — only the
  // cursor:pointer card. With real CSS that card is observed as role=generic
  // (live Chrome); include it so we can re-select and expose Delete.
  if (pool.length === 0) {
    pool = afterPlace.elements.filter((e) => {
      if (e.role !== 'generic') return false;
      if (beforeHandles.has(e.handle)) return false;
      const n = (e.name || '').trim().toLowerCase();
      if (!n || isDeleteChrome(n) || isNavOrCreate(n)) return false;
      if (n.includes('filter')) return false;
      return true;
    });
  }

  if (pool.length === 0) return null;
  // Prefer a control that was not present before the place.
  const fresh = pool.filter((e) => !beforeHandles.has(e.handle));
  const pick = fresh[0] ?? pool[pool.length - 1];
  return { name: pick.name, handle: pick.handle };
}

/**
 * Accessible names of canvas controls that appeared with the place.
 * Used to verify delete removed the probe even when selection/delete chrome
 * is gone and observation size alone looks clean.
 */
export function placedProbeCanvasNames(
  beforePlace: Observation,
  afterPlace: Observation,
): string[] {
  const beforeHandles = new Set(beforePlace.elements.map((e) => e.handle));
  const names: string[] = [];
  for (const e of afterPlace.elements) {
    if (beforeHandles.has(e.handle)) continue;
    const n = (e.name || '').trim();
    if (!n) continue;
    const lower = n.toLowerCase();
    if (matchesHintWord(lower, 'delete_element')) continue;
    if (lower.startsWith('<-') || lower.startsWith('+') || lower.startsWith('←')) continue;
    if (matchesHintWord(lower, 'ascend') || matchesHintWord(lower, 'chrome')) continue;
    if (lower.includes('filter')) continue;
    if (matchesHintExact(lower, 'panel_field')) continue;
    names.push(n);
  }
  return [...new Set(names)];
}

/**
 * True when a just-placed probe tile's accessible name still appears on a
 * handle that was not present before the place. Catches the live failure
 * where Delete appeared to succeed (panel closed) but the palette-named
 * canvas field remained for Freeze to persist.
 */
export function paletteNamedResiduePresent(
  beforePlace: Observation,
  current: Observation,
  placedNames: readonly string[],
): boolean {
  if (placedNames.length === 0) return false;
  const want = new Set(
    placedNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  if (want.size === 0) return false;
  const beforeHandles = new Set(beforePlace.elements.map((e) => e.handle));
  return current.elements.some((e) => {
    if (beforeHandles.has(e.handle)) return false;
    const n = (e.name || '').trim().toLowerCase();
    return want.has(n);
  });
}

/**
 * True when a just-placed probe still appears to occupy the canvas.
 *
 * Observation size alone lies for empty choice tiles: deselecting drops the
 * property panel (Delete Element/Node, Label, …) back to the pre-place size
 * while the tile remains in builder state with no perceivable canvas preview.
 * Live Chrome then Freezes that residue into Demographics (Hostile E2E v7
 * rosetta: 13 palette chrome names ahead of IR labels).
 *
 * Optional `placedNames` tightens the check: leftover palette-named fields
 * count as residue even when Delete chrome is gone and size matched.
 */
export function probeTileResiduePresent(
  beforePlace: Observation,
  current: Observation,
  placedNames: readonly string[] = [],
): boolean {
  if (findProbeDeleteAction(current)) return true;
  if (findPlacedProbeSelectTarget(beforePlace, current)) return true;
  if (paletteNamedResiduePresent(beforePlace, current, placedNames)) return true;
  return current.elements.length > beforePlace.elements.length;
}

/**
 * True when an element library / palette grid already looks open.
 *
 * FormCraft hides tiles behind "+ Add Element"; Zephyr/Nexus keep a strip
 * always visible. Counting non-chrome buttons (incl. nameless icon tiles)
 * distinguishes the two without hardcoding platform nouns.
 */
export function fieldPaletteSeemsOpen(obs: Observation): boolean {
  const actionable = enumerateActionable(obs);
  const tileLike = actionable.filter((e) => {
    const n = (e.name || '').trim().toLowerCase();
    if (e.role !== 'button' && e.role !== 'generic') return false;
    if (!n) return true; // icon-only library tiles
    if (n.startsWith('<-') || n.startsWith('←')) return false;
    if (n.startsWith('+')) return false; // library opener, not a tile
    if (matchesHintExact(n, 'non_palette_action', 'chrome', 'commit', 'discard', 'wizard_advance')) {
      return false;
    }
    if (matchesHintWord(n, 'ascend') || matchesHintWord(n, 'menu')) return false;
    return true;
  });
  return tileLike.length >= 5;
}

export class ProbeRunner {

  private driver: TabDriver;

  constructor(driver: TabDriver) {
    this.driver = driver;
  }

  /**
   * Open the element library when tiles are not yet on screen.
   * Uses field_palette.open ranking (no platform id hardcoding). Safe on
   * always-visible palettes: fieldPaletteSeemsOpen short-circuits.
   */
  async ensureFieldPaletteOpen(currentObs: Observation): Promise<Observation> {
    if (fieldPaletteSeemsOpen(currentObs)) return currentObs;

    const binding = bindFieldPaletteOpen(currentObs);
    const step = binding?.recipe?.[0];
    if (!step || step.step === 'wait') return currentObs;

    const pool = enumerateActionable(currentObs);
    let target = step.evidence_name
      ? pool.find((e) => (e.name || '').trim() === (step.evidence_name || '').trim())
      : undefined;
    if (!target) {
      target = rankCandidates(pool, { hint: 'palette' })[0]?.el;
    }
    if (!target) return currentObs;

    const clicked = await this.driver.click(target.handle);
    if (!clicked.ok) return currentObs;
    await this.sleep(250);
    return (await this.driver.perceiveAfterSettle(200)).observation;
  }

  /**
   * Run place-and-inspect probes on available palette buttons in the form builder.
   * Returns a map of CanonicalType -> BindingRecord grounded in structural diff evidence.
   */
  async probePalette(currentObs: Observation): Promise<{
    bindings: Partial<Record<CanonicalType, BindingRecord>>;
    discovered: DiscoveredPaletteItem[];
  }> {
    const bindings: Partial<Record<CanonicalType, BindingRecord>> = {};
    const discovered: DiscoveredPaletteItem[] = [];

    // FormCraft (env-wizard): tiles live in a modal behind "+ Add Element".
    // Probing the closed builder only sees chrome → radio/select never bind
    // ("Orbit Set" / "Pick One") and field throughput stalls ~18.
    currentObs = await this.ensureFieldPaletteOpen(currentObs);

    // Every actionable control is a palette candidate.
    //
    // Placing one and reading back what appeared is the only reliable way to
    // tell a palette tile from a toolbar button on an unseen platform: a tile
    // adds a control to the canvas, a toolbar button does not. Excluding
    // candidates by name here would silently skip whichever tile this platform
    // names unusually -- and the loop below already handles a non-tile
    // gracefully, since inspectPlacedControl reports observedRole 'none' and
    // the iteration moves on. That is the adjudication; a name filter would
    // pre-empt it.
    // Probing is DESTRUCTIVE: clicking a control to see whether it places a
    // field will, if that control is a nav link, navigate away from the
    // designer and break every probe after it. So the trial order puts the
    // palette region first, found structurally as the tightest container
    // holding the most controls, and the sweep is capped.
    const allActionable = enumerateActionable(currentObs);
    const cluster = largestControlCluster(allActionable);
    const ranked = rankCandidates(allActionable, {
      hint: 'palette',
      regionHandle: cluster?.regionHandle,
    });
    const inRegion = cluster
      ? ranked.filter((r) => cluster.members.some((m) => m.handle === r.el.handle))
      : [];
    const rest = ranked.filter((r) => !inRegion.includes(r));
    const MAX_PALETTE_TRIALS = 40;
    const candidateButtons = [...inRegion, ...rest]
      .map((r) => r.el)
      .filter((el) => isSafePaletteProbeCandidate(el.name))
      .slice(0, MAX_PALETTE_TRIALS);

    // Fingerprint: designer chrome that must survive a palette click. Losing
    // it means we navigated away and must stop probing.
    const designerFingerprint = new Set(
      allActionable
        .map((e) => (e.name || '').trim().toLowerCase())
        .filter((n) => /^(lock|freeze|preview|deploy|stash|bank it)$/.test(n)),
    );

    const openingObservation = currentObs;
    const placedNameLedger: string[] = [];

    for (const btn of candidateButtons) {
      try {
        // 1. Snapshot before click — re-resolve the tile by name. Prior
        //    place/delete cycles replaceChildren the builder; a handle from
        //    the opening observation can point at the wrong control once a
        //    toast or leftover tile has shifted paths (live Chrome / rosetta).
        let before = await this.driver.perceive();
        // Placing a tile may close a modal library — reopen before the next trial.
        const btnName = (btn.name || '').trim();
        const findBtn = (obs: Observation) =>
          enumerateActionable(obs).find((e) => (e.name || '').trim() === btnName);
        if (btnName && !findBtn(before.observation)) {
          const opened = await this.ensureFieldPaletteOpen(before.observation);
          before = { ...before, observation: opened };
        }
        const liveBtn = findBtn(before.observation) ?? btn;

        // 2. Click the candidate palette tile
        const clickRes = await this.driver.click(liveBtn.handle);
        if (!clickRes.ok) continue;

        // Brief settle for DOM render
        await this.sleep(250);

        // 3. Snapshot after click
        const after = await this.driver.perceiveAfterSettle(200);

        if (designerFingerprint.size > 0) {
          const afterNames = new Set(
            enumerateActionable(after.observation).map((e) => (e.name || '').trim().toLowerCase()),
          );
          const stillInDesigner = [...designerFingerprint].some((n) => afterNames.has(n));
          if (!stillInDesigner) {
            console.warn(
              `[ProbeRunner] Aborting palette probe after "${btn.name}": left the form designer`,
            );
            break;
          }
        }

        // 4. Inspect the placed control from the diff. A choice control that
        //    arrived empty is roleless, so give it values and look again.
        let observed = after.observation;
        let probe = inspectPlacedControl(before.observation, observed);
        if (!probe.declaredCanonical && probe.observedRole !== 'radiogroup' && probe.observedRole !== 'combobox') {
          observed = await this.revealWizardTypeEvidence(before.observation, observed);
          probe = inspectPlacedControl(before.observation, observed);
        }
        if (probe.hasOptionsEditor && needsChoiceDeepen(probe)) {
          observed = await this.deepenChoiceProbe(before.observation, observed);
          probe = inspectPlacedControl(before.observation, observed);
        }
        if (probe.observedRole === 'none' && !probe.declaredCanonical) {
          // Nothing useful appeared -- but a tile may still have landed (empty
          // choice / nameless canvas). Clean it up before skipping.
          if (diffObservations(before.observation, observed).added.length > 0) {
            const names = placedProbeCanvasNames(before.observation, observed);
            placedNameLedger.push(...names);
            await this.removePlacedProbe(before.observation, observed, names);
          }
          continue;
        }

        // 5. Classify against all 13 canonical types
        const matches: CanonicalType[] = [];
        for (const type of CANONICAL_TYPES) {
          const res = classifyTypeFromProbe(type, probe);
          if (res.matches) {
            matches.push(type);
          }
        }

        if (matches.length > 0) {
          discovered.push({
            name: liveBtn.name,
            handle: liveBtn.handle,
            probe,
            matchedTypes: matches,
          });

          for (const m of matches) {
            // Prefer a probe that matches fewer types (Solar Mark → [date]
            // via type picker beats Free String → [text,date,...] via role).
            const existing = bindings[m];
            const specificity = matches.length;
            const prevSpec = existing
              ? Number((existing.evidence.find((e) => e.startsWith('probe-specificity:')) || 'probe-specificity:99').split(':')[1])
              : 99;
            if (!existing || specificity < prevSpec) {
              const binding = makeTypeBinding(m, probe, liveBtn.name, liveBtn.handle, liveBtn.role);
              binding.evidence = [`probe-specificity:${specificity}`, ...binding.evidence];
              bindings[m] = binding;
            }
          }
        }

        // Always try to remove the probe tile. Leaving every palette click on
        // the canvas commits chrome names ("Derived Value", "Dial Group") as
        // fields beside the real IR labels (Hostile E2E v5 rosetta 21-field
        // Demographics), and reused panel handles break the next deepen.
        const names = placedProbeCanvasNames(before.observation, observed);
        placedNameLedger.push(...names);
        await this.removePlacedProbe(before.observation, observed, names);
      } catch (err) {
        console.warn(`[ProbeRunner] Failed probing button "${btn.name}":`, err);
      }
    }

    // Final sweep: any palette-named canvas field that survived a flaky delete
    // still counts as IR pollution once Freeze copies working → study.
    await this.sweepPaletteProbeResidue(openingObservation, placedNameLedger);

    return { bindings, discovered };
  }

  /**
   * Delete the selected probe tile from the canvas.
   *
   * Hostile builders expose "Delete Element" (rosetta) or "Delete Node"
   * (swapped). A single click on a stale observation handle is not enough:
   * deepen re-renders the panel, selection can be lost, and ACT re-perceives
   * before clicking — so a silent ok:false left every palette name on the
   * canvas (Hostile E2E v6 rosetta Demographics = 13 chrome + IR labels).
   *
   * Reliable cleanup: re-perceive, select the just-placed control, click
   * delete, verify the observation shrank, retry.
   */
  private async removePlacedProbe(
    beforePlace: Observation,
    afterPlace: Observation,
    placedNames: readonly string[] = placedProbeCanvasNames(beforePlace, afterPlace),
  ): Promise<void> {
    const baselineSize = beforePlace.elements.length;
    // If the place left a selected tile, we must land a real Delete click.
    // Size<=baseline without that click is the empty-choice false success
    // (panel chrome gone, tile still in working copy → Freeze persists it).
    const placedWithSelection = findProbeDeleteAction(afterPlace) !== null;
    let deleteClicked = false;
    let current = afterPlace;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Fresh snapshot so delete handles match ACT_EXECUTE's re-perceive.
      current = (await this.driver.perceive()).observation;
      const residue = probeTileResiduePresent(beforePlace, current, placedNames);
      if (!residue) {
        if (!placedWithSelection || deleteClicked) return;
        // Size matched without a delete click — keep trying to surface Delete.
      } else if (
        current.elements.length <= baselineSize
        && !placedWithSelection
        && !paletteNamedResiduePresent(beforePlace, current, placedNames)
      ) {
        return;
      }

      let del = findProbeDeleteAction(current);
      if (!del) {
        // Selection lost → panel hides Delete Element/Node. Re-select the
        // placed tile, then look again.
        const selectable = findPlacedProbeSelectTarget(beforePlace, current);
        if (selectable) {
          // Re-resolve by name right before ACT (toast / re-render shifts paths).
          current = (await this.driver.perceive()).observation;
          const live = findPlacedProbeSelectTarget(beforePlace, current)
            ?? selectable;
          const sel = await this.driver.click(live.handle);
          if (!sel.ok) {
            current = (await this.driver.perceive()).observation;
            const again = findPlacedProbeSelectTarget(beforePlace, current);
            if (again) {
              await this.driver.click(again.handle);
            }
          }
          await this.sleep(120);
          current = (await this.driver.perceive()).observation;
          del = findProbeDeleteAction(current);
        }
      }
      if (!del) continue;

      // Re-find Delete by name immediately before click — ACT_EXECUTE
      // re-perceives, and a toast (e.g. "Freeze the sheet before going live.")
      // between the prior snapshot and ACT makes the handle stale. Same
      // failure mode on rosetta more than swapped: Go Live sits next to the
      // horizontal palette and was previously a safe probe candidate.
      current = (await this.driver.perceive()).observation;
      del = findProbeDeleteAction(current) ?? del;
      let res = await this.driver.click(del.handle);
      if (!res.ok) {
        current = (await this.driver.perceive()).observation;
        const retry = findProbeDeleteAction(current);
        if (!retry) continue;
        res = await this.driver.click(retry.handle);
        if (!res.ok) continue;
      }
      deleteClicked = true;
      await this.sleep(180);
      current = (await this.driver.perceiveAfterSettle(150)).observation;
      if (!probeTileResiduePresent(beforePlace, current, placedNames)) return;
    }
  }

  /**
   * After the palette sweep, delete any canvas controls still named like a
   * tile we placed. Per-probe cleanup can lose a race (toast path-shift,
   * empty-choice false clean) and leave "Derived Value" … "Binary Flip" for
   * Freeze to persist — Hostile E2E v7 rosetta Demographics pollution.
   */
  private async sweepPaletteProbeResidue(
    beforeAll: Observation,
    placedNames: readonly string[],
  ): Promise<void> {
    const unique = [...new Set(placedNames.map((n) => n.trim()).filter(Boolean))];
    if (unique.length === 0) return;

    for (let pass = 0; pass < unique.length + 3; pass += 1) {
      const current = (await this.driver.perceive()).observation;
      if (!paletteNamedResiduePresent(beforeAll, current, unique)) return;

      // Prefer the shared select-target helper (fresh handles only).
      let selectable = findPlacedProbeSelectTarget(beforeAll, current);
      if (!selectable) {
        const beforeHandles = new Set(beforeAll.elements.map((e) => e.handle));
        const want = new Set(unique.map((n) => n.toLowerCase()));
        const hit = current.elements.find((e) => {
          if (beforeHandles.has(e.handle)) return false;
          const n = (e.name || '').trim().toLowerCase();
          return want.has(n);
        });
        if (hit) selectable = { name: hit.name, handle: hit.handle };
      }
      if (!selectable) return;

      await this.driver.click(selectable.handle);
      await this.sleep(120);
      let afterSel = (await this.driver.perceive()).observation;
      let del = findProbeDeleteAction(afterSel);
      if (!del) {
        // One more re-select by name in case the first click was a preview
        // control that did not promote selection.
        const again = findPlacedProbeSelectTarget(beforeAll, afterSel) ?? selectable;
        await this.driver.click(again.handle);
        await this.sleep(120);
        afterSel = (await this.driver.perceive()).observation;
        del = findProbeDeleteAction(afterSel);
      }
      if (!del) continue;
      const clicked = await this.driver.click(del.handle);
      if (!clicked.ok) continue;
      await this.sleep(180);
    }
  }

  /**
   * Give a placed choice control some values so it can reveal what it is.
   *
   * An EMPTY choice control is roleless: a radio group with no options and a
   * dropdown with no options both render as a bare container, so the probe
   * reads role 'generic' and can classify neither. Adding two values makes the
   * platform render the real control and the role appears -- verified on the
   * supplied mock, where "Radio Buttons" reads as 'generic' when empty and as
   * 'radio' once it has options.
   *
   * The add-value control is found among the actions the PROPERTY PANEL
   * brought with it, never across the whole page: ranking page-wide picks a
   * palette tile called "Check List" over the panel's "+ Add Value", because
   * both match the coded-value hint and the tile happens to come first.
   */
  /**
   * Wizard builders (FormCraft) show one property per step. After placing a
   * tile the agent lands on the label step — no type picker, no options editor.
   * Advance with the stepper until a type declaration or options editor appears
   * so empty Orbit Set / Pick One can classify without a human gate.
   */
  private async revealWizardTypeEvidence(
    beforePlace: Observation,
    afterPlace: Observation,
  ): Promise<Observation> {
    let current = afterPlace;
    for (let step = 0; step < 6; step += 1) {
      const probe = inspectPlacedControl(beforePlace, current);
      if (probe.declaredCanonical) return current;
      if (probe.hasOptionsEditor) return current;
      if (
        probe.observedRole === 'radiogroup'
        || probe.observedRole === 'radio'
        || probe.observedRole === 'combobox'
        || probe.observedRole === 'listbox'
      ) {
        return current;
      }
      const advance = findWizardAdvanceControl(current);
      if (!advance) return current;
      const before = current;
      const clicked = await this.driver.click(advance.handle);
      if (!clicked.ok) return current;
      await this.sleep(180);
      current = (await this.driver.perceiveAfterSettle(150)).observation;
      if (diffObservations(before, current).added.length === 0
        && diffObservations(before, current).changed.length === 0) {
        return current;
      }
    }
    return current;
  }

  private async deepenChoiceProbe(
    beforePlace: Observation,
    afterPlace: Observation,
  ): Promise<Observation> {
    // Include CHANGED handles, not only added. Hostile panels reuse DOM paths
    // across element types: after placing Logic Expr then Beam Pick, the
    // "+ Add Choice" button keeps the prior "Expression" handle, so an
    // added-only filter saw only "Append Pasted Choices", deepen no-op'd, and
    // radio never bound (Hostile E2E v5 swapped Sex at Birth gate).
    const diff = diffObservations(beforePlace, afterPlace);
    const panelHandles = new Set([...diff.added, ...diff.changed]);
    const panelActions = enumerateActions(afterPlace).filter((e) => panelHandles.has(e.handle));
    if (panelActions.length === 0) return afterPlace;

    // Rank by coded_values hints, but do NOT trust the top hit blindly.
    // "Apply Pasted Values" / "Append Pasted Choices" outrank "+ Add Value" /
    // "+ Add Choice" (they match paste+value/choice), yet with an empty paste
    // box they are no-ops. The previous loop clicked the winner once, saw no
    // diff, and aborted — so Dial Group / Beam Pick never gained options,
    // never revealed role=radio, and radio stayed unbound → human type-gate.
    const ranked = rankCandidates(panelActions, { hint: 'coded_values' });
    if (ranked.length === 0) return afterPlace;

    const ordered = orderChoiceDeepenCandidates(ranked.map((r) => r.el));

    let current = afterPlace;
    for (const candidate of ordered) {
      let progressed = false;
      for (let i = 0; i < 2; i += 1) {
        const before = current;
        const target = current.elements.find((e) => e.handle === candidate.handle)
          ? candidate.handle
          : null;
        if (!target) break;
        const res = await this.driver.click(target);
        if (!res.ok) break;
        await this.sleep(200);
        current = (await this.driver.perceiveAfterSettle(150)).observation;
        if (diffObservations(before, current).added.length === 0) break;
        progressed = true;
      }
      if (progressed) return current;
      // No-op candidate (e.g. Apply Pasted with empty box) — try the next one.
    }
    return current;
  }

  /**
   * Place ONE specific candidate and read back what appeared.
   *
   * This is the adjudication step for rung 2: the model names a candidate,
   * this places it, and the observed role decides whether the model was right.
   * Shares its logic with probePalette's sweep so the two cannot drift.
   */
  async placeAndInspect(handle: string): Promise<{
    probe: ProbeResult;
    matchedTypes: CanonicalType[];
  }> {
    const before = await this.driver.perceive();
    const clickRes = await this.driver.click(handle);
    if (!clickRes.ok) {
      return {
        probe: inspectPlacedControl(before.observation, before.observation),
        matchedTypes: [],
      };
    }
    await this.sleep(250);
    const after = await this.driver.perceiveAfterSettle(200);

    let observed = after.observation;
    let probe = inspectPlacedControl(before.observation, observed);
    if (!probe.declaredCanonical && probe.observedRole !== 'radiogroup' && probe.observedRole !== 'combobox') {
      observed = await this.revealWizardTypeEvidence(before.observation, observed);
      probe = inspectPlacedControl(before.observation, observed);
    }
    if (probe.hasOptionsEditor && needsChoiceDeepen(probe)) {
      observed = await this.deepenChoiceProbe(before.observation, observed);
      probe = inspectPlacedControl(before.observation, observed);
    }
    if (probe.observedRole === 'none' && !probe.declaredCanonical) {
      return { probe, matchedTypes: [] };
    }

    const matchedTypes = CANONICAL_TYPES.filter(
      (t) => classifyTypeFromProbe(t, probe).matches,
    );
    await this.removePlacedProbe(before.observation, observed);
    return { probe, matchedTypes };
  }

  /**
   * Probe candidate save/persist buttons to verify which one actually commits the draft.
   */
  async probeCommitButton(currentObs: Observation): Promise<{
    commitBinding: BindingRecord | null;
    evidence: string[];
  }> {
    // Trial order comes from ranking, not filtering. On a platform whose commit
    // control is named something nobody guessed, the ranking is near-flat and
    // the probe simply tries more candidates -- slower and correct, rather than
    // instant and wrong. The previous filter here required the name to contain
    // save/freeze/commit/persist/bank; 'freeze' and 'bank' were env-rosetta's
    // own invented words, added so that fixture would pass.
    let startObs = currentObs;
    // FormCraft hides Commit behind a hamburger; open short/menu controls once
    // so rankCommitCandidates can see it.
    // Exact name match only — commit hints also list "done"/"create", which are
    // visible on the wizard bar and must not skip opening the hamburger.
    const hasCommitControl = (obs: Observation) =>
      enumerateActionable(obs).some((e) => matchesHintExact(e.name, 'commit'));
    if (!hasCommitControl(startObs)) {
      const menuish = enumerateActions(startObs).filter((e) => {
        const n = (e.name || '').trim();
        if (!n) return false;
        if (n.length <= 2) return true;
        return matchesHintWord(n, 'menu') || matchesHintExact(n.toLowerCase(), 'menu');
      });
      for (const opener of menuish.slice(0, 3)) {
        const clicked = await this.driver.click(opener.handle);
        if (!clicked.ok) continue;
        await this.sleep(150);
        startObs = (await this.driver.perceive()).observation;
        if (hasCommitControl(startObs)) break;
      }
    }
    const candidates = rankCommitCandidates(startObs).map((r) => r.el);

    // A commit probe MUTATES state -- it clicks things, and a click can
    // navigate away. Cap the trials so a pathological page cannot cause an
    // unbounded click storm, and report honestly when the cap is reached
    // rather than claiming nothing could commit.
    const MAX_COMMIT_TRIALS = 12;
    const trials = candidates.slice(0, MAX_COMMIT_TRIALS);

    const evidence: string[] = [];

    for (const btn of trials) {
      try {
        const before = await this.driver.perceive();
        const res = await this.driver.click(btn.handle, false);
        if (!res.ok) continue;

        await this.sleep(300);
        const after = await this.driver.perceiveAfterSettle(300);

        const commitRes = analyzeCommit(before.observation, after.observation);
        evidence.push(`Tested "${btn.name}": committed=${commitRes.committed}`);

        if (commitRes.committed) {
          const binding: BindingRecord = {
            op: 'ctx.commit',
            version: 1,
            recipe: [
              { step: 'click', evidence_role: 'button', evidence_name: btn.name, handle_kind: 'snapshot-id' },
            ],
            post_condition: {
              description: 'changes committed, unsaved indicator removed',
            },
            evidence: [
              `Rung 1 commit probe confirmed button "${btn.name}" persists working copy`,
              ...commitRes.evidence,
            ],
            rung: 1,
            status: 'bound',
            // Probe-confirmed: this control demonstrably persisted the work.
            confidence: 'structural',
          };
          return { commitBinding: binding, evidence };
        }
      } catch (err) {
        evidence.push(`Error probing "${btn.name}": ${String(err)}`);
      }
    }

    if (candidates.length > trials.length) {
      evidence.push(
        `probed ${trials.length} of ${candidates.length} candidates (capped at ` +
        `${MAX_COMMIT_TRIALS}); no commit confirmed among them`,
      );
    }

    return { commitBinding: null, evidence };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
