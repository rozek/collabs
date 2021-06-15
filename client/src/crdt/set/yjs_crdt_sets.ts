import { YjsCrdtSetMessage } from "../../../generated/proto_compiled";
import { CausalTimestamp } from "../../net";
import {
  arrayAsString,
  DefaultElementSerializer,
  stringAsArray,
} from "../../util";
import { Crdt, CrdtParent } from "../core";
import { CrdtSet, CrdtSetEventsRecord } from "./interfaces";

// TODO: rename (odd to reference Yjs)

// TODO: allow args in create?
// Niche use case since you can just
// use CRDT ops a new value to do what you want, and
// requires adding an extra TArgs type param to the
// CrdtSet interface (since create() uses it).
/**
 * TODO: when you delete a Crdt, it is "frozen" -
 * no longer receives ops, doing ops locally causes an
 * error, not guaranteed EC.  Use has to check if it's
 * frozen.  Restore not allowed (2P-set semantics).
 */
export class YjsCrdtSet<C extends Crdt>
  extends Crdt<CrdtSetEventsRecord<C>>
  implements CrdtSet<C>, CrdtParent
{
  // TODO: rename
  private readonly children: Map<string, C> = new Map();
  constructor(
    private readonly valueCrdtConstructor: (creatorReplicaId: string) => C
  ) {
    super();
  }

  private childBeingAdded?: C;
  onChildInit(child: Crdt) {
    if (child != this.childBeingAdded) {
      throw new Error(
        "this was passed to Crdt.init as parent externally" +
          " (use this.new or a CompositeCrdt instead)"
      );
    }
  }

  private static nameSerializer =
    DefaultElementSerializer.getInstance<[string, number]>();

  private ourCreatedCrdt: C | undefined = undefined;
  protected receiveInternal(
    targetPath: string[],
    timestamp: CausalTimestamp,
    message: Uint8Array
  ): void {
    if (targetPath.length === 0) {
      let decoded = YjsCrdtSetMessage.decode(message);
      switch (decoded.op) {
        case "create":
          const newCrdt = this.valueCrdtConstructor(timestamp.getSender());
          // Add as child with "[sender, counter]" as id.
          // Similar to CompositeCrdt#addChild.
          let name = arrayAsString(
            YjsCrdtSet.nameSerializer.serialize([
              timestamp.getSender(),
              decoded.create,
            ])
          );
          if (this.children.has(name)) {
            throw new Error('Duplicate newCrdt name: "' + name + '"');
          }
          this.children.set(name, newCrdt);
          this.childBeingAdded = newCrdt;
          newCrdt.init(name, this);
          this.childBeingAdded = undefined;

          this.emit("ValueInit", { value: newCrdt });
          this.emit("Add", { value: newCrdt, timestamp });

          if (timestamp.isLocal()) {
            this.ourCreatedCrdt = newCrdt;
          }
          break;
        case "delete":
          const valueCrdt = this.children.get(decoded.delete);
          if (valueCrdt !== undefined) {
            this.children.delete(decoded.delete);
            this.emit("Delete", { value: valueCrdt, timestamp });
          }
          break;
        default:
          throw new Error("Unknown decoded.op: " + decoded.op);
      }
    } else {
      // Message for an existing child.  Proceed as in
      // CompositeCrdt.
      let child = this.children.get(targetPath[targetPath.length - 1]);
      if (child === undefined) {
        // Assume it's a message for a deleted (hence
        // frozen) child.
        if (timestamp.isLocal()) {
          throw new Error(
            "Operation performed on deleted " +
              "(hence frozen) child of YjsCrdtSet, name: " +
              targetPath[targetPath.length - 1]
          );
        } else {
          // Ignore
          return;
        }
      }
      targetPath.length--;
      child.receive(targetPath, timestamp, message);
    }
  }

  getDescendant(targetPath: string[]): Crdt {
    if (targetPath.length === 0) return this;

    let child = this.children.get(targetPath[targetPath.length - 1]);
    if (child === undefined) {
      // Assume it is a deleted (frozen) child.
      // It seems hard to prevent getDescendant calls
      // concurrent to a delete, which we want to return
      // a frozen Crdt instead of an error.  So, here
      // we return a fake frozen Crdt, which matches
      // the expected semantics because has() will be false.
      const nameDeserialized = YjsCrdtSet.nameSerializer.deserialize(
        stringAsArray(targetPath[targetPath.length - 1]),
        this.runtime
      );
      return this.valueCrdtConstructor(nameDeserialized[0]);
    }
    targetPath.length--;
    return child.getDescendant(targetPath);
  }

  canGc(): boolean {
    return this.children.size === 0;
  }

  create(): C {
    // TODO: replica unique number makes the op non-pure.
    // But using senderCounter would be dangerous if we
    // runLocally, thus reusing timestamps, or if we
    // decide to reuse timestamps for batched messages.
    let message = YjsCrdtSetMessage.create({
      create: this.runtime.getReplicaUniqueNumber(),
    });
    this.runtime.send(this, YjsCrdtSetMessage.encode(message).finish());
    let created = this.ourCreatedCrdt;
    if (created === undefined) {
      // TODO: use assertion instead
      throw new Error("Bug: created was undefined");
    }
    this.ourCreatedCrdt = undefined;
    return created;
  }

  restore(_valueCrdt: C): this {
    throw new Error(
      "YjsCrdtSet.restore not supported" + " (deletes are permanent)"
    );
  }

  delete(valueCrdt: C): boolean {
    const had = this.has(valueCrdt);
    if (had) {
      let message = YjsCrdtSetMessage.create({
        delete: valueCrdt.name,
      });
      this.runtime.send(this, YjsCrdtSetMessage.encode(message).finish());
    }
    return had;
  }

  owns(valueCrdt: C): boolean {
    return valueCrdt.parent === this;
  }

  has(valueCrdt: C): boolean {
    this.checkOwns(valueCrdt);
    return this.children.has(valueCrdt.name);
  }

  get size(): number {
    return this.children.size;
  }

  values(): IterableIterator<C> {
    return this.children.values();
  }

  clear(): void {
    // TODO: optimize
    for (let value of this) this.delete(value);
  }

  reset(): void {
    this.clear();
  }

  /**
   * Throws an error if !this.owns(valueCrdt).
   */
  protected checkOwns(valueCrdt: C) {
    if (!this.owns(valueCrdt)) {
      throw new Error("valueCrdt is not owned by this CrdtSet");
    }
  }

  [Symbol.iterator](): IterableIterator<C> {
    return this.values();
  }

  *entries(): IterableIterator<[C, C]> {
    for (let value of this.values()) {
      yield [value, value];
    }
  }

  keys(): IterableIterator<C> {
    return this.values();
  }
}
