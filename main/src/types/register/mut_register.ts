import { Resettable } from "../../abilities";
import { CompositeCrdt } from "../../constructions";
import { Crdt } from "../../core";
import {
  ElementSerializer,
  DefaultElementSerializer,
  Optional,
  CrdtSerializer,
} from "../../util";
import { DeletingMutCSet } from "../set";
import { CRegisterEntryMeta } from "./aggregate_register";
import { CRegister, CRegisterEventsRecord } from "./interfaces";
import { OptionalLwwCRegister } from "./wins_registers";

export class MutCRegisterFromRegister<
    C extends Crdt,
    SetArgs extends any[],
    Value,
    RegT extends CRegister<Value, [C]>,
    Events extends CRegisterEventsRecord<Value> = CRegisterEventsRecord<Value>
  >
  extends CompositeCrdt<Events>
  implements CRegister<Value, SetArgs>
{
  protected readonly crdtFactory: DeletingMutCSet<C, SetArgs>;
  protected readonly register: RegT;

  /**
   * Note initial value behavior
   * depends on that of the register returned by
   * registerCallback.
   *
   * @param registerCallback [description]
   */
  constructor(
    registerCallback: (valueSerializer: ElementSerializer<C>) => RegT,
    valueConstructor: (...args: SetArgs) => C,
    argsSerializer: ElementSerializer<SetArgs> = DefaultElementSerializer.getInstance()
  ) {
    super();
    this.crdtFactory = this.addChild(
      "",
      new DeletingMutCSet(valueConstructor, [], argsSerializer)
    );
    this.register = this.addChild(
      "0",
      registerCallback(new CrdtSerializer(this.crdtFactory))
    );

    // Events
    this.register.on("Set", (event) => this.emit("Set", event));
  }

  set(...args: SetArgs): Value {
    this.crdtFactory.clear();
    return this.register.set(this.crdtFactory.add(...args));
  }

  get value(): Value {
    return this.register.value;
  }

  owns(value: C): boolean {
    return this.crdtFactory.owns(value);
  }
}

export class LwwMutCRegister<C extends Crdt, SetArgs extends any[]>
  extends MutCRegisterFromRegister<
    C,
    SetArgs,
    Optional<C>,
    OptionalLwwCRegister<C>
  >
  implements Resettable
{
  constructor(
    valueConstructor: (...args: SetArgs) => C,
    argsSerializer: ElementSerializer<SetArgs> = DefaultElementSerializer.getInstance()
  ) {
    super(
      (registerValueSerializer) =>
        new OptionalLwwCRegister(registerValueSerializer),
      valueConstructor,
      argsSerializer
    );
  }

  conflicts(): C[] {
    return this.register.conflicts();
  }

  conflictsMeta(): CRegisterEntryMeta<C>[] {
    return this.register.conflictsMeta();
  }

  reset() {
    this.crdtFactory.reset();
    this.register.reset();
  }
}