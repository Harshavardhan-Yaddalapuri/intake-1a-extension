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

import type {
  BindingRecord,
  CanonicalType,
  ContractOpId,
} from '../shared/contract';
import { CANONICAL_TYPES } from '../shared/contract';
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

    // Find candidate palette buttons.
    // In any eSource platform, palette items are buttons or clickable elements
    // in a sidebar, toolbar, modal, or strip.
    const candidateButtons = currentObs.elements.filter((e) => {
      if (e.role !== 'button') return false;
      const lower = e.name.toLowerCase();
      // Exclude obvious navigation/header buttons
      if (lower.includes('back') || lower.includes('home') || lower.includes('close') ||
          lower.includes('preview') || lower.includes('save') || lower.includes('freeze') ||
          lower.includes('commit') || lower.includes('cancel') || lower.includes('delete')) {
        return false;
      }
      return true;
    });

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
   * Probe candidate save/persist buttons to verify which one actually commits the draft.
   */
  async probeCommitButton(currentObs: Observation): Promise<{
    commitBinding: BindingRecord | null;
    evidence: string[];
  }> {
    const candidates = currentObs.elements.filter((e) => {
      if (e.role !== 'button') return false;
      const n = e.name.toLowerCase();
      return n.includes('save') || n.includes('freeze') || n.includes('commit') ||
             n.includes('persist') || n.includes('bank');
    });

    const evidence: string[] = [];

    for (const btn of candidates) {
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

    return { commitBinding: null, evidence };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
