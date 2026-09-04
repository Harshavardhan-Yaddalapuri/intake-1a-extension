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
import { enumerateActionable, rankCandidates } from '../bind/ranking';
import { rankCommitCandidates } from '../bind/rung0';

export interface DiscoveredPaletteItem {
  name: string;
  handle: string;
  probe: ProbeResult;
  matchedTypes: CanonicalType[];
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
    const candidateButtons = rankCandidates(
      enumerateActionable(currentObs),
      { hint: 'palette' },
    ).map((r) => r.el);

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

        // 4. Inspect the placed control from the diff
        const probe = inspectPlacedControl(before.observation, after.observation);
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

    const probe = inspectPlacedControl(before.observation, after.observation);
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
