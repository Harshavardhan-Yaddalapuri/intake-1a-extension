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
import { enumerateActionable, enumerateActions, rankCandidates, largestControlCluster } from '../bind/ranking';
import { rankCommitCandidates } from '../bind/rung0';

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

export class ProbeRunner {
  private driver: TabDriver;

  constructor(driver: TabDriver) {
    this.driver = driver;
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
      .slice(0, MAX_PALETTE_TRIALS)
      .map((r) => r.el);

    for (const btn of candidateButtons) {
      try {
        // 1. Snapshot before click
        const before = await this.driver.perceive();

        // 2. Click the candidate palette tile
        const clickRes = await this.driver.click(btn.handle);
        if (!clickRes.ok) continue;

        // Brief settle for DOM render
        await this.sleep(250);

        // 3. Snapshot after click
        const after = await this.driver.perceiveAfterSettle(200);

        // 4. Inspect the placed control from the diff. A choice control that
        //    arrived empty is roleless, so give it values and look again.
        let observed = after.observation;
        let probe = inspectPlacedControl(before.observation, observed);
        if (probe.hasOptionsEditor && needsChoiceDeepen(probe)) {
          observed = await this.deepenChoiceProbe(before.observation, observed);
          probe = inspectPlacedControl(before.observation, observed);
        }
        if (probe.observedRole === 'none') {
          // Nothing appeared on canvas -- not an element creator
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
            name: btn.name,
            handle: btn.handle,
            probe,
            matchedTypes: matches,
          });

          for (const m of matches) {
            // If not yet bound or if this is a more specific match, bind it
            if (!bindings[m]) {
              bindings[m] = makeTypeBinding(m, probe, btn.name, btn.handle);
            }
          }
        }
      } catch (err) {
        console.warn(`[ProbeRunner] Failed probing button "${btn.name}":`, err);
      }
    }

    return { bindings, discovered };
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
  private async deepenChoiceProbe(
    beforePlace: Observation,
    afterPlace: Observation,
  ): Promise<Observation> {
    const appeared = new Set(diffObservations(beforePlace, afterPlace).added);
    const panelActions = enumerateActions(afterPlace).filter((e) => appeared.has(e.handle));
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
    if (probe.hasOptionsEditor && needsChoiceDeepen(probe)) {
      observed = await this.deepenChoiceProbe(before.observation, observed);
      probe = inspectPlacedControl(before.observation, observed);
    }
    if (probe.observedRole === 'none') return { probe, matchedTypes: [] };

    const matchedTypes = CANONICAL_TYPES.filter(
      (t) => classifyTypeFromProbe(t, probe).matches,
    );
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
    const candidates = rankCommitCandidates(currentObs).map((r) => r.el);

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
