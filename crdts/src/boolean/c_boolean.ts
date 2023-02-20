import { InitToken, Serializer } from "@collabs/core";
import { Aggregator } from "../map";
import { CVar } from "../var";

class BooleanSerializer implements Serializer<boolean> {
  private static readonly TRUE = new Uint8Array();
  private static readonly FALSE = new Uint8Array(1);

  private constructor() {
    // Not constructable.
  }

  static readonly instance = new BooleanSerializer();

  serialize(value: boolean): Uint8Array {
    return value ? BooleanSerializer.TRUE : BooleanSerializer.FALSE;
  }

  deserialize(message: Uint8Array): boolean {
    return message.length === 0;
  }
}

const TrueWinsAggregator: Aggregator<boolean> = {
  aggregate(items) {
    // True if there are any true values.
    return items.find((item) => item.value) !== undefined;
  },
} as const;

const FalseWinsAggregator: Aggregator<boolean> = {
  aggregate(items) {
    // False if there are any false values.
    return items.find((item) => !item.value) === undefined;
  },
} as const;

export class CBoolean extends CVar<boolean> {
  /**
   *
   * @param init
   * @param param1 winner: if true, Enable-Wins Flag; else Disable-Wins Flag.
   */
  constructor(init: InitToken, { winner = true, initialValue = false } = {}) {
    super(init, initialValue, {
      valueSerializer: BooleanSerializer.instance,
      aggregator: winner ? TrueWinsAggregator : FalseWinsAggregator,
    });
  }
}