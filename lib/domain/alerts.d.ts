/**
 * Pure derivation of "what needs a human" from the durable factory record.
 *
 * Why this module exists
 * ----------------------
 * Before it, an `escalate` verdict and an `await_approval` gate had **no
 * consumer**: the only thing that ever read them was the model turn that asked
 * for them, so a factory could sit parked for as long as the user never looked
 * at the panel, and a member that never acquired a session was visible only as
 * a `spawnError` field nobody rendered. The host exposes no notification API
 * (`docs/limitations.md` §10), so the honest fix is a channel that is derived
 * from disk on every read, cannot be dismissed, and is impossible to miss in
 * the panel.
 *
 * Contract
 * --------
 *  - **Pure.** No I/O, no clock, no randomness. The whole list is a function of
 *    `FactoryState` plus the pipeline template, which is why it can be asserted
 *    against fixtures and why it survives a reload and a cold restart.
 *  - **Derived, never stored.** There is no `alerts.json` to fall out of sync
 *    with `factory.json`; the list is recomputed on every snapshot.
 *  - **Total.** A stage id whose template disappeared from the registry still
 *    produces an alert — it degrades to the raw id instead of being dropped.
 *  - **Ordered.** `action` before `attention`, then pipeline order, then roster
 *    order. A renderer may take `[0]` and be right about the most urgent item.
 *
 * @module dsh-code-factory/domain/alerts
 */
import type { FactoryState, SnapshotAlert } from '../shared/types.js';
/**
 * Every reason this factory is not green, most urgent first.
 *
 * @param state - the durable record read from `factory.json`.
 * @returns the alert list; empty means nothing is blocked on anyone.
 */
export declare function deriveAlerts(state: FactoryState): SnapshotAlert[];
