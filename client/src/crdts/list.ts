import { Crdt, CrdtRuntime } from "./crdt_core";
import { ConstructorArgs, Resettable } from "./mixins";
import { ElementSerializer } from "./utils";
import createTree from "functional-red-black-tree";
import { Tree } from "functional-red-black-tree";

// TODO: events

/**
 * A source of opaque immutable identifiers of type I
 * from a dense total order.
 */
export interface IDenseSource<I> extends ElementSerializer<I> {
  /**
   * Same semantics as compareFunction supplied to
   * Array.sort: return < 0 if a < b, > 0 if a > b,
   * 0 if equivalent.
   * @param  a [description]
   * @param  b [description]
   * @return   [description]
   */
  compare(a: I, b: I): number;

  /**
   * Return a fresh (not used before) identifier greater
   * than before but less than after.  before and after
   * can be assumed to be adjacent on the generating
   * replica, but they may not be adjacent on all replicas,
   * since other replicas may concurrently make an
   * identical method call.
   *
   * Typically freshness is ensured by attaching a unique id
   * from CrdtRuntime.getUniqueId(), which can be used as
   * an arbitrary tie-breaker between elements that
   * would otherwise be equivalently ordered.
   *
   * @param  before [description]
   * @param  after  [description]
   * @return        [description]
   */
  between(before: I, after: I): I;

  /**
   * Like between, but return count identifiers,
   * in order from least to greatest.
   * @param  before [description]
   * @param  after  [description]
   * @param  count  [description]
   * @return        [description]
   */
  betweenRange(before: I, after: I, count: number): I[];

  /**
   * A formal identifier less than all identifers
   * actually used.  Use this as
   * before when inserting at the beginning of a sequence.
   */
  readonly start: I;
  /**
   * A formal identifier greater than all identifers
   * actually used.  Use this as
   * after when inserting at the end of a sequence.
   */
  readonly end: I;
}

/**
 * A mutable sequence of opaque immutable identifiers
 * of type I.  This is not a Crdt, although it is still
 * aware of replication: add may called on identifiers
 * that were generated by a different instance that has
 * performed a causally ordered subset of the add
 * and delete operations performed on this instance.
 */
export interface IOpaqueSequence<I> extends ElementSerializer<I> {
  // Set methods

  add(id: I): void;

  delete(id: I): void;

  has(id: I): boolean;

  // Creating new ids

  /**
   * Inserts a fresh identifier at the given index,
   * returning it.
   * Existing identifiers
   * at index or later are shifted right.
   *
   * Index may be in the range
   * [0, this.length].  If it equals this.length,
   * the elements are appended to the end of the list.
   * @param index       [description]
   * @param ...elements [description]
   */
  createBetween(before: I, after: I): I;

  /**
   * Like createAndAdd, but inserts count new identifiers,
   * returning them in order from left to right.
   * @param  index [description]
   * @param  count [description]
   * @return       [description]
   */
  createBetweenRange(before: I, after: I, count: number): I[];

  // Sequence methods

  /**
   * Get the identifier at the given index in
   * the current list.  Note that identifiers
   * may move from their original positions
   * due to insertions or deletions at lesser
   * indices.
   *
   * @param  index [description]
   * @return       [description]
   */
  get(index: number): I;

  /**
   * Return the current index of id, or undefined
   * if it has been deleted.
   * @param  id [description]
   * @return    [description]
   */
  indexOf(id: I): number | undefined;

  /**
   * Delete the identifier at the given index in
   * the current list.  Later identifier are
   * shifted left.
   *
   * Once an identifier is deleted by any replica,
   * it is deleted permanently; there is no possibility
   * for an "insert-wins" semantics because insertions
   * are unique.
   *
   * @param index [description]
   */
  deleteAt(index: number): void;

  createAt(index: number): I;

  createAtRange(index: number, count: number): I[];

  readonly length: number;

  asArray(): I[];

  // Compare

  /**
   * Same semantics as compareFunction supplied to
   * Array.sort: return < 0 if a < b, > 0 if a > b,
   * 0 if equivalent.  Lists are in increasing order.
   * @param  a [description]
   * @param  b [description]
   * @return   [description]
   */
  compare(a: I, b: I): number;
}

export class DenseSourceSequence<I> implements IOpaqueSequence<I> {
  // Note this is a functional data structure (add, remove
  // return new instances; they're not mutators).
  private sequence: Tree<I, I>;
  constructor(private readonly denseSource: IDenseSource<I>) {
    this.sequence = createTree(denseSource.compare.bind(denseSource));
  }

  add(id: I): void {
    this.sequence = this.sequence.insert(id, id);
  }

  delete(id: I): void {
    this.sequence = this.sequence.remove(id);
  }

  has(id: I): boolean {
    return this.sequence.find(id) !== null;
  }

  createBetween(before: I, after: I): I {
    let created = this.denseSource.between(before, after);
    this.add(created);
    return created;
  }

  createBetweenRange(before: I, after: I, count: number): I[] {
    let created = this.denseSource.betweenRange(before, after, count);
    for (let id of created) this.add(id);
    return created;
  }

  get(index: number): I {
    if (index < 0 || index >= this.length) {
      throw new Error(
        "index out of bounds: " + index + " (length: " + this.length + ")"
      );
    }
    return this.sequence.at(index).key!;
  }

  indexOf(id: I): number | undefined {
    let iter = this.sequence.find(id);
    if (iter === null) return undefined;
    else return iter.index;
  }

  deleteAt(index: number): void {
    this.delete(this.get(index));
  }

  createAt(index: number): I {
    let before = index === 0 ? this.denseSource.start : this.get(index - 1);
    let after = index === this.length ? this.denseSource.end : this.get(index);
    return this.createBetween(before, after);
  }

  createAtRange(index: number, count: number): I[] {
    let before = index === 0 ? this.denseSource.start : this.get(index - 1);
    let after = index === this.length ? this.denseSource.end : this.get(index);
    return this.createBetweenRange(before, after, count);
  }

  get length(): number {
    return this.sequence.length;
  }

  asArray(): I[] {
    return this.sequence.keys;
  }

  compare(a: I, b: I): number {
    return this.denseSource.compare(a, b);
  }

  serialize(value: I): Uint8Array {
    return this.denseSource.serialize(value);
  }

  deserialize(message: Uint8Array, runtime: CrdtRuntime): I {
    return this.denseSource.deserialize(message, runtime);
  }
}

/**
 * Mixin to automatically create subclasses of
 * DenseSourceSequence that use a given IDenseSource
 * implementation.  The subclasses take the same
 * constructor arguments as the given IDenseSource.
 *
 * E.g.: const LseqOpaqueSequence = WrapDenseSource(LseqDenseSource);
 */
export function WrapDenseSource<
  I,
  S extends IDenseSource<I>,
  Args extends any[]
>(
  DenseSource: ConstructorArgs<Args, S>
): ConstructorArgs<Args, DenseSourceSequence<I>> {
  return class Wrapped extends DenseSourceSequence<I> {
    constructor(...args: Args) {
      super(new DenseSource(...args));
    }
  };
}

// TODO: replace below with actual classes.  All flexibility
// in the IOpaqueSequence.

/**
 * A list whose elements are atoms, i.e.,
 * immutable values (although they may be references
 * to mutable values).  Elements can be
 * inserted at a given position or deleted,
 * but not modified in-place.
 *
 * In case of concurrent insertions, they may
 * be arbitrarily ordered with respect to each
 * other, but they will always be ordered properly
 * with respect to elements that existed at
 * their time of insertion.
 *
 * TODO: a way to get permanent ids for list locations,
 * which you can use to access an element even if
 * it moves due to other operations?
 *
 * TODO: way to undelete an entry (besides concurrent
 * ops)?
 *
 * @type T the type of list elements
 */
export interface IAtomicList<T> extends Crdt {
  /**
   * Get the element at the given index in
   * the current list.  Note that elements
   * may move from their original positions
   * due to insertions or deletions at lesser
   * indices.
   *
   * @param  index [description]
   * @return       [description]
   */
  get(index: number): T;

  /**
   * Delete the element at the given index in
   * the current list.  Later elements are
   * shifted left.
   *
   * Once an element is deleted by any replica,
   * it is deleted permanently; there is no possibility
   * for an "insert-wins" semantics because insertions
   * are unique.
   *
   * @param index [description]
   */
  delete(index: number): void;

  /**
   * Insert the given elements starting at the
   * given index.  Existing elements
   * at index or later are shifted right.
   *
   * Index may be in the range
   * [0, this.length].  If it equals this.length,
   * the elements are appended to the end of the list.
   * @param index       [description]
   * @param ...elements [description]
   */
  insert(index: number, ...elements: T[]): void;

  /**
   * Append the given elements to the end of the list.
   * Alias for this.insert(this.length, ...elements).
   */
  push(...elements: T[]): void;

  readonly length: number;

  asArray(): T[];
}

/**
 * A Crdt-valued List, similar to MapCrdt but with
 * list indices instead of arbitrary keys.
 *
 * TODO: way to undelete an entry (besides concurrent
 * ops)?
 */
export interface IList<C extends Crdt & Resettable> {
  get(index: number): C;
  /**
   * Deletes the given index from the list,
   * also resetting its Crdt.  In case there are concurrent
   * operations on the value Crdt, the deletion is
   * cancelled out.  Later elements are
   * shifted left.
   *
   * @param index [description]
   */
  delete(index: number): void;

  /**
   * Deletes the given value from the list,
   * also resetting it.  In case there are concurrent
   * operations on the value Crdt, the deletion is
   * cancelled out.  Later elements are
   * shifted left.
   * @param value [description]
   */
  delete(value: C): void;

  /**
   * Inserts a new value at the given index and
   * returns the new value.  Existing elements
   * at index or later are shifted right.
   *
   * Index may be in the range
   * [0, this.length].  If it equals this.length,
   * the elements are appended to the end of the list.
   * @param  index [description]
   * @return       [description]
   */
  insert(index: number): C;

  asArray(): C[];
}
