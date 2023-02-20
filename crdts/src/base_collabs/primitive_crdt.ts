import {
  CollabEventsRecord,
  CPrimitive,
  InitToken,
  UpdateMeta,
} from "@collabs/core";
import { CRDTMeta, CRDTMetaProvider, CRDTMetaRequest } from "../runtime";

/**
 * Superclass for a primitive (message-passing)
 * operation-based CRDT.
 *
 * Messages sent with [[sendCRDT]] are delivered to all
 * replica's [[receiveCRDT]] methods (including the sender's)
 * exactly once, in causal order, and tagged with
 * [[CRDTMessageMeta]]. Sent messages are delivered to the local
 * replica immediately. Subclasses are expected to implement
 * an operation-based CRDT algorithm using these methods.
 *
 * Besides renaming send and receive to sendCRDT and receiveCRDT,
 * the only user-facing difference between [[PrimitiveCRDT]]
 * and [[CPrimitive]] is that this class supplies
 * [[CRDTMessageMeta]] to recipients.
 *
 * To function, a [[PrimitiveCRDT]] must have an ancestor
 * that supplies the extra [[UpdateMeta]] key
 * [[CRDTMeta.MESSAGE_META_KEY]] (typically [[CRDTMetaLayer]]). Also, its ancestors
 * must deliver messages exactly once, in causal order,
 * with sent messages delivered to the local replica immediately.
 */
export abstract class PrimitiveCRDT<
  Events extends CollabEventsRecord = CollabEventsRecord
> extends CPrimitive<Events> {
  constructor(init: InitToken) {
    super(init);

    if (
      (this.runtime as unknown as CRDTMetaProvider).providesCRDTMeta !== true
    ) {
      throw new Error(
        "this.runtime must be CRuntime or another CRDTMetaProvider"
      );
    }
  }

  /**
   * Send `message` to all replicas' [[receiveCRDT]] methods.
   *
   * By default, only [[CRDTMeta]] fields read during the sender's
   * own [[receivePrimitive]] call (i.e., the local echo) are
   * broadcast to remote replicas. This is sufficient for most use cases, but you
   * should think carefully through the steps that
   * remote recipients would take, and ensure that they
   * only need to access the same metadata as the sender.
   * In particular, ensure that it is okay for
   * remote replicas to see incorrect 0 entries in
   * the vector clock, so long as that only happens with
   * entries not accessed by the sender. An easy way to accidentally break this
   * is with "shortcuts" that assume sequential behavior when
   * `meta.senderID === this.runtime.replicaID`.
   *
   * You can explicitly request additional [[CRDTMeta]] fields using `request`:
   * - `vectorClockKeys`: Include the vector clock entries with the
   * specified keys (`replicaID`'s). Non-requested entries may return 0
   * instead of their correct value (as if no messages had been received from
   * that replica).
   * - `wallClockTime`: If true, include non-null [[CRDTMeta.wallClockTime]].
   * - `lamportTimestamp`: If true, nclude non-null [[CRDTMeta.lamportTimestamp]].
   */
  protected sendCRDT(
    message: Uint8Array | string,
    request?: CRDTMetaRequest
  ): void {
    super.sendPrimitive(message, request);
  }

  /**
   * Do not override; override [[receiveCRDT]] instead.
   */
  protected receivePrimitive(
    message: Uint8Array | string,
    meta: UpdateMeta
  ): void {
    const crdtMeta = <CRDTMeta>meta.runtimeExtra;
    if (crdtMeta === undefined) {
      throw new Error("No CRDTMeta supplied; ensure you are using CRuntime");
    }
    this.receiveCRDT(message, meta, crdtMeta);
  }

  /**
   * Override to receive messages sent with [[sendCRDT]].
   *
   * This abstract method is like [[CPrimitive.receivePrimitive]] or
   * [[Collab.receive]], except it also provides `crdtMeta`.
   * That contains metadata useful for implementing op-based CRDTs,
   * e.g., a vector clock.
   */
  protected abstract receiveCRDT(
    message: Uint8Array | string,
    meta: UpdateMeta,
    crdtMeta: CRDTMeta
  ): void;
}