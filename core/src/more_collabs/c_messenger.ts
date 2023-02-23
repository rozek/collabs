import { CPrimitive } from "../base_collabs/c_primitive";
import {
  CollabEvent,
  CollabEventsRecord,
  InitToken,
  UpdateMeta,
} from "../core";
import { DefaultSerializer, Serializer } from "../util";

/**
 * Event emitted by a [[CMessenger]] when it receives a message.
 */
export interface MessengerEvent<M> extends CollabEvent {
  /**
   * The received message.
   */
  message: M;
}

/**
 * Events record for a [[CMessenger]].
 */
export interface MessengerEventsRecord<M> extends CollabEventsRecord {
  /**
   * Emitted when a message is received.
   */
  Message: MessengerEvent<M>;
}

/**
 * A collaborative messenger.
 *
 * This Collab has no state; it merely broadcasts messages between replicas.
 * To receive messages, listen on Message events.
 *
 * Note that when using the standard library (@collabs/collabs or @collabs/crdts),
 * concurrent messages may be received in different orders on different replicas.
 *
 * @typeParam M The type of messages.
 */
export class CMessenger<M> extends CPrimitive<MessengerEventsRecord<M>> {
  private readonly messageSerializer: Serializer<M>;

  /**
   * @param options.messageSerializer A serializer for messages.
   * Defaults to [[DefaultSerializer]].
   */
  constructor(
    init: InitToken,
    options: { messageSerializer?: Serializer<M> } = {}
  ) {
    super(init);

    this.messageSerializer =
      options.messageSerializer ?? DefaultSerializer.getInstance();
  }

  /**
   * Sends the given message. It will be delivered in a Message event on
   * all replicas, including this one.
   */
  sendMessage(message: M): void {
    const encoded = this.messageSerializer.serialize(message);
    super.sendPrimitive(encoded);
  }

  protected receivePrimitive(
    message: Uint8Array | string,
    meta: UpdateMeta
  ): void {
    const decoded = this.messageSerializer.deserialize(<Uint8Array>message);
    this.emit("Message", {
      message: decoded,
      meta,
    });
  }

  savePrimitive() {
    return null;
  }

  loadPrimitive(): void {
    // No-op.
  }

  canGC(): boolean {
    return true;
  }
}
