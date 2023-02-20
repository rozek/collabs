import { Buffer } from "buffer";
import {
  ArrayMessage,
  CollabIDMessage,
  DefaultSerializerMessage,
  IDefaultSerializerMessage,
  ObjectMessage,
  PairSerializerMessage,
} from "../../generated/proto_compiled";
import { Collab, CollabID } from "../core";
import { Optional } from "./optional";
import { SafeWeakRef } from "./safe_weak_ref";

/**
 * A serializer for values of type `T` (e.g., elements
 * in Collabs collections), so that they can
 * be sent to other replicas in Collabs operations.
 *
 * [[DefaultSerializer.getInstance]]`()` should suffice for most uses.
 * An exception is serializing [[CollabID]]s, which requires
 * [[CollabIDSerializer]].
 */
export interface Serializer<T> {
  serialize(value: T): Uint8Array;
  deserialize(message: Uint8Array): T;
}

// In this file, we generally cache instances in case each
// element of a collection constructs a derived serializer
// from a fixed given one.

/**
 * Default serializer.
 *
 * Supported types are a superset of JSON:
 * - Primitive types (string, number, boolean, undefined, null)
 * - Arrays and plain (non-class) objects, serialized recursively (this includes [[CollabID]]s)
 * - Uint8Array
 * - [[Optional]]<T>, with T serialized recursively.
 *
 * All other types cause an error during [[serialize]].
 */
export class DefaultSerializer<T> implements Serializer<T> {
  private constructor() {
    // Constructor is just here to mark it as private.
  }

  private static instance = new this();

  static getInstance<T>(): DefaultSerializer<T> {
    return <DefaultSerializer<T>>this.instance;
  }

  serialize(value: T): Uint8Array {
    let message: IDefaultSerializerMessage;
    switch (typeof value) {
      case "string":
        message = { stringValue: value };
        break;
      case "number":
        if (Number.isSafeInteger(value)) {
          message = { intValue: value };
        } else {
          message = { doubleValue: value };
        }
        break;
      case "boolean":
        message = { booleanValue: value };
        break;
      case "undefined":
        message = { undefinedValue: true };
        break;
      case "object":
        if (value === null) {
          message = { nullValue: true };
        } else if (value instanceof Uint8Array) {
          message = {
            bytesValue: value,
          };
        } else if (Array.isArray(value)) {
          // Technically types are bad for recursive
          // call to this.serialize, but it's okay because
          // we ignore our generic type.
          message = {
            arrayValue: ArrayMessage.create({
              elements: value.map((element) => this.serialize(element)),
            }),
          };
        } else if (value instanceof Optional) {
          message = {
            optionalValue: {
              valueIfPresent: value.isPresent
                ? this.serialize(value.get())
                : undefined,
            },
          };
        } else {
          const constructor = (<object>(<unknown>value)).constructor;
          if (constructor === Object) {
            // Technically types are bad for recursive
            // call to this.serialize, but it's okay because
            // we ignore our generic type.
            const properties: { [key: string]: Uint8Array } = {};
            for (const [key, property] of Object.entries(value)) {
              properties[key] = this.serialize(property);
            }
            message = {
              objectValue: ObjectMessage.create({
                properties,
              }),
            };
          } else if (value instanceof Collab) {
            throw new Error(
              "Collab serialization is not supported; serialize a CollabID instead"
            );
          } else {
            throw new Error(
              `Unsupported class type for DefaultSerializer: ${constructor.name}; you must use a custom serializer or a plain (non-class) Object`
            );
          }
        }
        break;
      default:
        throw new Error(
          `Unsupported type for DefaultSerializer: ${typeof value}; you must use a custom Serializer`
        );
    }
    return DefaultSerializerMessage.encode(message).finish();
  }

  deserialize(message: Uint8Array): T {
    const decoded = DefaultSerializerMessage.decode(message);
    let ans: unknown;
    switch (decoded.value) {
      case "stringValue":
        ans = decoded.stringValue;
        break;
      case "intValue":
        ans = int64AsNumber(decoded.intValue);
        break;
      case "doubleValue":
        ans = decoded.doubleValue;
        break;
      case "booleanValue":
        ans = decoded.booleanValue;
        break;
      case "undefinedValue":
        ans = undefined;
        break;
      case "nullValue":
        ans = null;
        break;
      case "arrayValue":
        ans = decoded.arrayValue!.elements!.map((serialized) =>
          this.deserialize(serialized)
        );
        break;
      case "objectValue":
        ans = {};
        for (const [key, serialized] of Object.entries(
          decoded.objectValue!.properties!
        )) {
          (<Record<string, unknown>>ans)[key] = this.deserialize(serialized);
        }
        break;
      case "bytesValue":
        ans = decoded.bytesValue;
        break;
      case "optionalValue":
        if (
          Object.prototype.hasOwnProperty.call(
            decoded.optionalValue,
            "valueIfPresent"
          )
        ) {
          ans = Optional.of(
            this.deserialize(decoded.optionalValue!.valueIfPresent!)
          );
        } else ans = Optional.empty();
        break;
      default:
        throw new Error(`Bad message format: decoded.value=${decoded.value}`);
    }
    // No way of checking if it's really type T.
    return ans as T;
  }
}

export class StringSerializer implements Serializer<string> {
  private constructor() {
    // Use StringSerializer.instance instead.
  }
  serialize(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "utf-8"));
  }
  deserialize(message: Uint8Array): string {
    return Buffer.from(message).toString("utf-8");
  }
  static readonly instance = new StringSerializer();
}

/**
 * Serializes [T] using a serializer for T.  This is slightly more efficient
 * than the default serializer, and also works with arbitrary T.
 */
export class SingletonSerializer<T> implements Serializer<[T]> {
  private constructor(private readonly valueSerializer: Serializer<T>) {}

  serialize(value: [T]): Uint8Array {
    return this.valueSerializer.serialize(value[0]);
  }

  deserialize(message: Uint8Array): [T] {
    return [this.valueSerializer.deserialize(message)];
  }

  // Weak in both keys and values.
  private static cache = new WeakMap<
    Serializer<unknown>,
    WeakRef<SingletonSerializer<unknown>>
  >();

  static getInstance<T>(
    valueSerializer: Serializer<T>
  ): SingletonSerializer<T> {
    const existingWeak = SingletonSerializer.cache.get(valueSerializer);
    if (existingWeak !== undefined) {
      const existing = existingWeak.deref();
      if (existing !== undefined) return <SingletonSerializer<T>>existing;
    }
    const ret = new SingletonSerializer(valueSerializer);
    SingletonSerializer.cache.set(valueSerializer, new SafeWeakRef(ret));
    return ret;
  }
}

export class PairSerializer<T, U> implements Serializer<[T, U]> {
  constructor(
    private readonly oneSerializer: Serializer<T>,
    private readonly twoSerializer: Serializer<U>
  ) {}

  serialize(value: [T, U]): Uint8Array {
    const message = PairSerializerMessage.create({
      one: this.oneSerializer.serialize(value[0]),
      two: this.twoSerializer.serialize(value[1]),
    });
    return PairSerializerMessage.encode(message).finish();
  }

  deserialize(message: Uint8Array): [T, U] {
    const decoded = PairSerializerMessage.decode(message);
    return [
      this.oneSerializer.deserialize(decoded.one),
      this.twoSerializer.deserialize(decoded.two),
    ];
  }
}

const emptyUint8Array = new Uint8Array();

export class TrivialSerializer<T> implements Serializer<T> {
  constructor(readonly value: T) {}

  serialize(_value: T): Uint8Array {
    return emptyUint8Array;
  }

  deserialize(_message: Uint8Array): T {
    return this.value;
  }
}

export class CollabIDSerializer<C extends Collab>
  implements Serializer<CollabID<C>>
{
  private constructor() {
    // Singleton.
  }

  private static instance = new this<Collab>();

  static getInstance<C extends Collab>(): CollabIDSerializer<C> {
    return this.instance;
  }

  serialize(value: CollabID<C>): Uint8Array {
    const message = CollabIDMessage.create({ namePath: value.namePath });
    return CollabIDMessage.encode(message).finish();
  }

  deserialize(message: Uint8Array): CollabID<C> {
    const decoded = CollabIDMessage.decode(message);
    return { namePath: decoded.namePath };
  }
}

/**
 * Apply this function to protobuf.js uint64 and sint64 output values
 * to convert them to the nearest JS number (double).
 * For safe integers, this is exact.
 *
 * In theory you can "request" protobuf.js to not use
 * Longs by not depending on the Long library, but that is
 * flaky because a dependency might import it.
 */
export function int64AsNumber(num: number | Long): number {
  if (typeof num === "number") return num;
  else return num.toNumber();
}