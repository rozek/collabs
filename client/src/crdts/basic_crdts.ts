import { CrdtEvent, Crdt, CrdtEventsRecord, PrimitiveCrdt } from "./crdt_core";
import { CausalTimestamp } from "../network";
import {
  CounterPureBaseMessage,
  CounterResettableMessage,
  GSetMessage,
  LwwMessage,
  MultRegisterMessage,
  MvrMessage,
} from "../../generated/proto_compiled";
import { DefaultElementSerializer, ElementSerializer } from "./utils";
import { LocallyResettableState, ResetWrapClass } from "./resettable";
import {
  makeEventAdder,
  OutOfOrderAble,
  Resettable,
  ResettableEventsRecord,
} from "./mixins";

export class NumberState implements LocallyResettableState {
  private readonly initialValue: number;
  constructor(public value: number) {
    this.initialValue = value;
  }
  resetLocalState(): void {
    this.value = this.initialValue;
  }
}

export interface AddEvent extends CrdtEvent {
  readonly valueAdded: number;
}

export interface CounterEventsRecord extends CrdtEventsRecord {
  Add: AddEvent;
}

export interface ICounter extends Crdt<CounterEventsRecord> {
  add(toAdd: number): void;
  /**
   *  Setting value performs an equivalent add.
   */
  value: number;
}

export class CounterPureBase
  extends PrimitiveCrdt<NumberState, CounterEventsRecord>
  implements ICounter, OutOfOrderAble {
  constructor(initialValue: number = 0) {
    super(new NumberState(initialValue));
  }

  add(toAdd: number) {
    if (toAdd !== 0) {
      let message = CounterPureBaseMessage.create({ toAdd: toAdd });
      let buffer = CounterPureBaseMessage.encode(message).finish();
      super.send(buffer);
    }
  }

  protected receive(timestamp: CausalTimestamp, message: Uint8Array) {
    let decoded = CounterPureBaseMessage.decode(message);
    this.state.value += decoded.toAdd;
    this.emit("Add", {
      caller: this,
      timestamp,
      valueAdded: decoded.toAdd,
    });
  }

  get value(): number {
    return this.state.value;
  }
  /**
   * Performs an equivalent add.
   */
  set value(value: number) {
    this.add(value - this.value);
  }

  receiveOutOfOrder(
    targetPath: string[],
    timestamp: CausalTimestamp,
    message: Uint8Array
  ): void {
    this.receiveGeneral(targetPath, timestamp, message);
  }
}

const AddCounterEvents = makeEventAdder<CounterEventsRecord>();

// TODO: issue with makeEventsAdder: when you type .emit or .on, the new ones
// don't show up in the tooltip.  However they do compile.
// Should check whether Typedoc shows them correctly.

/**
 * TODO: Counter with pure operations.  Less efficient state size.
 */
export class CounterPure
  extends AddCounterEvents(ResetWrapClass(CounterPureBase))
  implements ICounter, Resettable {
  constructor(initialValue = 0) {
    super(initialValue);
    this.original.on("Add", (event) =>
      this.emit("Add", { ...event, caller: this })
    );
  }
  add(toAdd: number): void {
    this.original.add(toAdd);
  }
  get value(): number {
    return this.original.value;
  }
  set value(value: number) {
    this.original.value = value;
  }
}
// TODO: StrongResettable

export class CounterState {
  plusP: { [k: string]: number } = {};
  plusN: { [k: string]: number } = {};
  minusP: { [k: string]: number } = {};
  minusN: { [k: string]: number } = {};
}

export class Counter
  extends PrimitiveCrdt<
    CounterState,
    CounterEventsRecord & ResettableEventsRecord
  >
  implements ICounter, Resettable {
  constructor(readonly initialValue: number = 0) {
    super(new CounterState());
  }

  add(toAdd: number) {
    if (toAdd !== 0) {
      let message = CounterResettableMessage.create({ toAdd: toAdd });
      let buffer = CounterResettableMessage.encode(message).finish();
      super.send(buffer);
    }
  }

  reset() {
    let message = CounterResettableMessage.create({
      toReset: {
        plusReset: this.state.plusP,
        minusReset: this.state.minusP,
      },
    });
    let buffer = CounterResettableMessage.encode(message).finish();
    super.send(buffer);
  }

  protected receive(timestamp: CausalTimestamp, message: Uint8Array) {
    let decoded = CounterResettableMessage.decode(message);
    switch (decoded.data) {
      case "toAdd":
        if (decoded.toAdd > 0) {
          let current = this.state.plusP[timestamp.getSender()];
          if (current === undefined) current = 0;
          this.state.plusP[timestamp.getSender()] = current + decoded.toAdd;
        } else {
          let current = this.state.minusP[timestamp.getSender()];
          if (current === undefined) current = 0;
          this.state.minusP[timestamp.getSender()] = current - decoded.toAdd;
        }
        this.emit("Add", {
          caller: this,
          timestamp,
          valueAdded: decoded.toAdd,
        });
        break;
      case "toReset":
        this.merge(this.state.plusN, decoded.toReset!.plusReset!);
        this.merge(this.state.minusN, decoded.toReset!.minusReset!);
        this.emit("Reset", {
          caller: this,
          timestamp: timestamp,
        });
        // TODO: event: also include metadata about non-reset ops?
        break;
      default:
        throw new Error("CounterResettable: Bad decoded.data: " + decoded.data);
    }
  }

  private merge(
    target: { [k: string]: number },
    source: { [k: string]: number }
  ) {
    for (let k of Object.keys(source)) {
      if (target[k] === undefined || target[k] < source[k]) {
        target[k] = source[k];
      }
    }
  }

  get value(): number {
    let value = this.initialValue;
    value += this.addValues(this.state.plusP);
    value -= this.addValues(this.state.plusN);
    value -= this.addValues(this.state.minusP);
    value += this.addValues(this.state.minusN);
    return value;
  }

  private addValues(record: { [k: string]: number }) {
    let ans = 0;
    for (let value of Object.values(record)) ans += value;
    return ans;
  }
  /**
   * Performs an equivalent add.
   */
  set value(value: number) {
    this.add(value - this.value);
  }
}

// TODO: StrongResettable

// export class Counter
//   extends AddStrongResettable(CounterResettable)
//   implements AllAble {
//   static withAbilities<F extends AbilityFlag>(
//     abilityFlag: F,
//     parentOrRuntime: Crdt | CrdtRuntime,
//     id: string,
//     initialValue: number = 0
//   ): CounterBase & InterfaceOf<F> {
//     if (abilityFlag.resettable !== undefined) {
//       if (abilityFlag.strongResettable !== undefined) {
//         return new Counter(parentOrRuntime, id, initialValue) as any;
//       } else {
//         return new CounterResettable(parentOrRuntime, id, initialValue) as any;
//       }
//     } else {
//       if (abilityFlag.strongResettable !== undefined) {
//         return new CounterStrongResettable(
//           parentOrRuntime,
//           id,
//           initialValue
//         ) as any;
//       } else {
//         return new CounterPureBase(parentOrRuntime, id, initialValue) as any;
//       }
//     }
//   }
// }

export interface MultEvent extends CrdtEvent {
  readonly valueMulted: number;
}

export interface MultEventsRecord extends CrdtEventsRecord {
  Mult: MultEvent;
}

export interface IMultRegister extends Crdt<MultEventsRecord> {
  mult(toMult: number): void;
  /**
   *  Setting value performs an equivalent mult.
   */
  value: number;
}

export class MultRegisterBase
  extends PrimitiveCrdt<NumberState, MultEventsRecord>
  implements IMultRegister {
  constructor(readonly initialValue: number = 1) {
    super(new NumberState(initialValue));
  }

  mult(toMult: number) {
    if (toMult !== 1) {
      let message = MultRegisterMessage.create({ toMult: toMult });
      let buffer = MultRegisterMessage.encode(message).finish();
      super.send(buffer);
    }
  }

  protected receive(timestamp: CausalTimestamp, message: Uint8Array): boolean {
    let decoded = MultRegisterMessage.decode(message);
    this.state.value *= decoded.toMult;
    this.emit("Mult", {
      caller: this,
      timestamp,
      valueMulted: decoded.toMult,
    });
    return true;
  }

  get value(): number {
    return this.state.value;
  }
  /**
   * Performs an equivalent mult.
   */
  set value(value: number) {
    this.mult(value / this.value);
  }
}

const AddMultEvents = makeEventAdder<MultEventsRecord>();

export class MultRegister
  extends AddMultEvents(ResetWrapClass(MultRegisterBase))
  implements IMultRegister, Resettable {
  constructor(initialValue = 1) {
    super(initialValue);
    this.original.on("Mult", (event) =>
      this.emit("Mult", { ...event, caller: this })
    );
  }
  mult(toMult: number): void {
    this.original.mult(toMult);
  }
  get value(): number {
    return this.original.value;
  }
  set value(value: number) {
    this.original.value = value;
  }
}
// TODO: StrongResettable

export interface SetAddEvent<T> extends CrdtEvent {
  readonly valueAdded: T;
}

export interface GSetEventsRecord<T> extends CrdtEventsRecord {
  SetAdd: SetAddEvent<T>;
}

export class GSet<T>
  extends PrimitiveCrdt<Set<T>, GSetEventsRecord<T>>
  implements OutOfOrderAble {
  /**
   * Grow-only set with elements of type T.
   *
   * The default serializer behaves as follows.  string, number,
   * undefined, and null types are stored
   * by-value, as in ordinary JS Set's, so that different
   * instances of the same value are identified
   * (even if they are added by different
   * replicas).  Crdt types are stored
   * by-reference, as they would be in ordinary JS set's,
   * with replicas of the same Crdt being identified
   * (even if they are added by different replicas).
   * Other types are serialized using BSON (via
   * https://github.com/mongodb/js-bson).  Note this means
   * that they will effectively be sent by-value to other
   * replicas, but on each replica, they are treated by reference,
   * following JS's usual set semantics.
   */
  constructor(
    private readonly elementSerializer: ElementSerializer<T> = DefaultElementSerializer.getInstance()
  ) {
    super(new Set());
  }

  add(value: T) {
    // TODO: if we make this resettable, send values
    // anyway (or make that an option).
    if (!this.has(value)) {
      let message = GSetMessage.create({
        toAdd: this.elementSerializer.serialize(value),
      });
      let buffer = GSetMessage.encode(message).finish();
      super.send(buffer);
    }
  }

  has(value: T) {
    return this.state.has(value);
  }

  protected receive(timestamp: CausalTimestamp, message: Uint8Array): boolean {
    let decoded = GSetMessage.decode(message);
    let value = this.elementSerializer.deserialize(decoded.toAdd, this.runtime);
    if (!this.state.has(value)) {
      this.state.add(value);
      this.emit("SetAdd", { caller: this, timestamp, valueAdded: value });
      return true;
    } else return false;
  }

  receiveOutOfOrder(
    targetPath: string[],
    timestamp: CausalTimestamp,
    message: Uint8Array
  ): void {
    // GSet Add ops are commutative, so OoO doesn't matter
    this.receiveGeneral(targetPath, timestamp, message);
  }

  /**
   * Don't mutate this directly.
   */
  get value(): Set<T> {
    return this.state;
  }

  // TODO: other helper methods
}

export interface IGSet<T> extends GSet<T> {}

// TODO: resettable GSet?  Share common interface.  Needs to track timestamps
// like MVR.

export class MvrEntry<T> {
  constructor(
    readonly value: T,
    readonly sender: string,
    readonly counter: number
  ) {}
}

export interface MvrEvent<T> extends CrdtEvent {
  readonly valueAdded: T;
  readonly valuesRemoved: Set<T>;
}

export interface MvrEventsRecord<T> extends CrdtEventsRecord {
  Mvr: MvrEvent<T>;
  Reset: CrdtEvent;
}

// TODO: initial values?  Or just wait for generic way (runLocally)?
// TODO: strong reset
export class MultiValueRegister<T> extends PrimitiveCrdt<
  Set<MvrEntry<T>>,
  MvrEventsRecord<T>
> {
  /**
   * Multi-value register of type T.
   *
   * The default serializer behaves as follows.  string, number,
   * undefined, and null types are stored
   * by-value, as in ordinary JS Set's, so that different
   * instances of the same value are identified
   * (even if they are added by different
   * replicas).  Crdt types are stored
   * by-reference, as they would be in ordinary JS set's,
   * with replicas of the same Crdt being identified
   * (even if they are added by different replicas).
   * Other types are serialized using BSON (via
   * https://github.com/mongodb/js-bson).  Note this means
   * that they will effectively be sent by-value to other
   * replicas, but on each replica, they are treated by reference,
   * following JS's usual set semantics.
   */
  constructor(
    private readonly valueSerializer: ElementSerializer<T> = DefaultElementSerializer.getInstance()
  ) {
    super(new Set<MvrEntry<T>>());
  }

  set value(value: T) {
    let message = MvrMessage.create({
      value: this.valueSerializer.serialize(value),
    });
    let buffer = MvrMessage.encode(message).finish();
    super.send(buffer);
  }

  reset() {
    let message = MvrMessage.create({
      reset: true,
    }); // no value
    let buffer = MvrMessage.encode(message).finish();
    super.send(buffer);
  }

  protected receive(timestamp: CausalTimestamp, message: Uint8Array): boolean {
    let decoded = MvrMessage.decode(message);
    let removed = new Set<T>();
    let vc = timestamp.asVectorClock();
    for (let entry of this.state) {
      let vcEntry = vc.get(entry.sender);
      if (vcEntry !== undefined && vcEntry >= entry.counter) {
        this.state.delete(entry);
        removed.add(entry.value);
      }
    }
    switch (decoded.data) {
      case "value":
        // Add the new entry
        let value = this.valueSerializer.deserialize(
          decoded.value,
          this.runtime
        );
        this.state.add(
          new MvrEntry(
            value,
            timestamp.getSender(),
            timestamp.getSenderCounter()
          )
        );
        if (removed.size === 1 && removed.entries().next().value === value) {
          return false; // no change to actual value
        } else {
          this.emit("Mvr", {
            caller: this,
            timestamp,
            valueAdded: value,
            valuesRemoved: removed,
          });
          return true;
        }
      case "reset":
        this.emit("Reset", { caller: this, timestamp });
        return removed.size === 0;
      // TODO: also do normal Mvr event?  Would need to make valueAdded
      // optional.
      default:
        throw new Error(
          "MultiValueRegister: Bad decoded.data: " + decoded.data
        );
    }
  }

  /**
   * Return the current set of values, i.e., the
   * set of non-overwritten values.  This may have
   * more than one element due to concurrent writes,
   * or it may have zero elements because the register is
   * newly initialized or has been reset.
   */
  get valueSet(): Set<T> {
    let values = new Set<T>();
    for (let entry of this.state) values.add(entry.value);
    return values;
  }
}

export interface IMultiValueRegister<T> extends MultiValueRegister<T> {}

export interface LwwEvent<T> extends CrdtEvent {
  readonly value: T;
  readonly oldValue: T;
  readonly timeSet: Date;
}

export interface LwwEventsRecord<T> extends CrdtEventsRecord {
  Lww: LwwEvent<T>;
}

export interface ILwwRegister<T> extends Crdt<LwwEventsRecord<T>> {}

export class LwwState<T> implements LocallyResettableState {
  value: T;
  // TODO: initialValue might unexpectedly prevent GC, or
  // change mutably
  constructor(
    public initialValue: T,
    public sender: string | null,
    public counter: number,
    public time: number | null
  ) {
    this.value = initialValue;
  }

  resetLocalState(): void {
    this.value = this.initialValue;
    this.sender = null;
    this.counter = -1;
    this.time = null;
  }
}

export class LwwRegisterBase<T>
  extends PrimitiveCrdt<LwwState<T>, LwwEventsRecord<T>>
  implements ILwwRegister<T> {
  /**
   * Last-writer-wins (LWW) register of type T.  Ties
   * between concurrent messages are based on UTC
   * timestamps (however, a message will always overwrite
   * a causally prior value regardless of timestamps).
   *
   * The default serializer behaves as follows.  string, number,
   * undefined, and null types are stored
   * by-value, as in ordinary JS Set's, so that different
   * instances of the same value are identified
   * (even if they are added by different
   * replicas).  Crdt types are stored
   * by-reference, as they would be in ordinary JS set's,
   * with replicas of the same Crdt being identified
   * (even if they are added by different replicas).
   * Other types are serialized using BSON (via
   * https://github.com/mongodb/js-bson).  Note this means
   * that they will effectively be sent by-value to other
   * replicas, but on each replica, they are treated by reference,
   * following JS's usual set semantics.
   */
  constructor(
    initialValue: T,
    private readonly valueSerializer: ElementSerializer<T> = DefaultElementSerializer.getInstance()
  ) {
    super(new LwwState(initialValue, null, -1, null));
  }

  set value(value: T) {
    let message = LwwMessage.create({
      value: this.valueSerializer.serialize(value),
      time: Date.now(),
    });
    let buffer = LwwMessage.encode(message).finish();
    super.send(buffer);
  }

  get value(): T {
    return this.state.value;
  }

  protected receive(timestamp: CausalTimestamp, message: Uint8Array): boolean {
    let decoded = LwwMessage.decode(message);
    let value = this.valueSerializer.deserialize(decoded.value, this.runtime);
    // See if it's causally greater than the current state
    let vc = timestamp.asVectorClock();
    let overwrite = false;
    if (this.state.sender === null) {
      // Initial element
      overwrite = true;
    } else {
      let vcEntry = vc.get(this.state.sender);
      if (vcEntry !== undefined && vcEntry >= this.state.counter) {
        overwrite = true;
      }
    }
    // If it's concurrent, compare timestamps.  Use
    // arbitrary order on sender as tiebreaker.
    if (!overwrite) {
      if (decoded.time > this.state.time!) overwrite = true;
      else if (decoded.time == this.state.time) {
        overwrite = timestamp.getSender() > this.state.sender!;
      }
    }

    if (overwrite) {
      let changed = this.state.value !== value;
      let oldValue = this.state.value;
      this.state.counter = timestamp.getSenderCounter();
      this.state.sender = timestamp.getSender();
      this.state.time = decoded.time;
      this.state.value = value;
      if (changed) {
        this.emit("Lww", {
          caller: this,
          timestamp,
          value,
          oldValue,
          timeSet: new Date(decoded.time),
        });
      }
      return changed;
    } else return false;
  }
}

// TODO: doesn't work due to missing type parameter
// const AddLwwEvents = makeEventAdder<LwwEventsRecord>();

export class LwwRegister<T>
  extends ResetWrapClass(LwwRegisterBase, true)<T>
  implements ILwwRegister<T>, Resettable {
  get value(): T {
    return this.original.value;
  }
  set value(value: T) {
    this.original.value = value;
  }
  /**
   * Returns true if this register has never received
   * any operations, or if all operations have been
   * reset.
   * @return if this register is in the initial state
   */
  isInInitialState(): boolean {
    return this.original.state.sender === null;
  }
}
// TODO: StrongResettable
