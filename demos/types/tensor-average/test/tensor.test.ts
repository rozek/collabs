import { CRuntime, TestingRuntimes } from "@collabs/collabs";
import * as tf from "@tensorflow/tfjs-node";
import { assert } from "chai";
import {
  conversions,
  TensorAverageCollab,
  TensorCounterCollab,
  TensorGCounterCollab,
} from "../src/";

describe("tensor", () => {
  let runtimeGen: TestingRuntimes;
  let alice: CRuntime;
  let bob: CRuntime;

  beforeEach(() => {
    runtimeGen = new TestingRuntimes();
    alice = runtimeGen.newRuntime();
    bob = runtimeGen.newRuntime();
    tf.engine().startScope();
  });

  afterEach(() => {
    tf.engine().endScope();
  });

  function assertTensorIsNaN<R extends tf.Rank>(actual: tf.Tensor<R>): void {
    assert(
      tf.all(actual.isNaN()).arraySync() === 1,
      failedAssertionMessage(actual, NaN)
    );
  }

  function assertTensorsStrictEqual<R extends tf.Rank>(
    actual: tf.Tensor<R>,
    expected: tf.Tensor<R> | number
  ): void {
    assert(
      tf.all(actual.equal(expected)).arraySync() === 1,
      failedAssertionMessage(actual, expected)
    );
  }

  function assertTensorsApproxEqual<R extends tf.Rank>(
    actual: tf.Tensor<R>,
    expected: tf.Tensor<R> | number,
    epsilon: number = 0.0001
  ): void {
    assert(
      tf.all(actual.sub(expected).abs().lessEqual(epsilon)).arraySync() === 1,
      failedAssertionMessage(actual, expected)
    );
  }

  function failedAssertionMessage(
    actual: tf.Tensor,
    expected: tf.Tensor | number
  ): string {
    return (
      "Expected all values in a to equal b.\n" +
      `  a: ${actual.toString(true)}\n` +
      `  b: ${
        typeof expected === "number"
          ? `Tensor of ${expected}`
          : (expected as tf.Tensor).toString(true)
      }\n`
    );
  }

  describe("conversions", () => {
    it("converts tensors back to their original value", () => {
      const tensor1 = tf.zeros([2, 2], "float32").add(1);
      const message = conversions.tfToProtobuf.tensor(tensor1);
      const tensor2 = conversions.protobufToTF.tensor(message);
      assert.strictEqual(tensor1.dtype, "float32");
      assertTensorsStrictEqual(tensor1, tensor2);
    });
  });

  describe("TensorGCounter", function () {
    this.slow(1000); // tensor operations on large tensors can be slow
    const shape = [100, 20, 10];
    let aliceCounter: TensorGCounterCollab;
    let bobCounter: TensorGCounterCollab;

    beforeEach(() => {
      aliceCounter = alice.registerCollab(
        "counterId",
        (init) => new TensorGCounterCollab(init, shape, "float32")
      );
      bobCounter = bob.registerCollab(
        "counterId",
        (init) => new TensorGCounterCollab(init, shape, "float32")
      );
    });

    it("is initially all zero", () => {
      assertTensorsStrictEqual(aliceCounter.value, 0);
      assertTensorsStrictEqual(bobCounter.value, 0);
    });

    describe("add", () => {
      it("works for non-concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(1);
        const tensor2 = tf.zeros(shape).add(2);
        const tensor3 = tf.zeros(shape).add(3);

        aliceCounter.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        bobCounter.add(tensor2);
        const expected1 = tensor1.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, expected1);
        assertTensorsStrictEqual(bobCounter.value, expected1);

        aliceCounter.add(tensor3);
        const expected2 = expected1.add(tensor3);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, expected2);
        assertTensorsStrictEqual(bobCounter.value, expected2);
      });

      it("works for concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(10);
        const tensor2 = tf.zeros(shape).add(20);
        const sum = tensor1.add(tensor2);

        aliceCounter.add(tensor1);
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, 0);

        bobCounter.add(tensor2);
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor2);

        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, sum);
        assertTensorsStrictEqual(bobCounter.value, sum);
      });

      it("throws an error for tensors containing negative values", () => {
        assert.throws(() => aliceCounter.add(tf.zeros(shape).add(-1)));
      });
    });

    describe("reset", () => {
      it("works for non-concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(5);
        const tensor2 = tf.zeros(shape).add(10);

        bobCounter.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        aliceCounter.reset();
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, 0);
        assertTensorsStrictEqual(bobCounter.value, 0);

        bobCounter.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor2);
        assertTensorsStrictEqual(bobCounter.value, tensor2);
      });

      it("works for non-concurrent reset followed by add", () => {
        const tensor1 = tf.zeros(shape).add(324);
        const tensor2 = tf.zeros(shape).add(213);

        aliceCounter.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        aliceCounter.reset();
        assertTensorsStrictEqual(aliceCounter.value, 0);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        aliceCounter.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor2);
        assertTensorsStrictEqual(bobCounter.value, tensor2);
      });

      it("lets concurrent adds survive", () => {
        const tensor = tf.zeros(shape).add(10);

        aliceCounter.add(tensor);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor);
        assertTensorsStrictEqual(bobCounter.value, tensor);

        aliceCounter.reset();
        bobCounter.add(tensor);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor);
        assertTensorsStrictEqual(bobCounter.value, tensor);
      });

      it("lets concurrent non-uniform adds survive", () => {
        const shape = [2, 2];
        const dtype = "float32";
        const aliceCounter = alice.registerCollab(
          "counterId2",
          (init) => new TensorGCounterCollab(init, shape, dtype)
        );
        const bobCounter = bob.registerCollab(
          "counterId2",
          (init) => new TensorGCounterCollab(init, shape, dtype)
        );

        const identity = tf.eye(shape[0], shape[1], undefined, "float32");
        const tensor1 = identity.mul(2);
        const tensor2 = identity.reverse().mul(3);
        const sum = tensor1.add(tensor2);

        aliceCounter.add(tensor1);
        bobCounter.add(tensor2);
        runtimeGen.release(bob, alice);
        assertTensorsStrictEqual(aliceCounter.value, sum);
        assertTensorsStrictEqual(bobCounter.value, tensor2);

        bobCounter.reset();

        runtimeGen.release(alice, bob);
        assertTensorsStrictEqual(aliceCounter.value, sum);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        runtimeGen.release(bob, alice);
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor1);
      });
    });
  });

  describe("TensorCounter", function () {
    this.slow(1000); // tensor operations on large tensors can be slow
    const shape = [100, 100];
    let aliceCounter: TensorCounterCollab;
    let bobCounter: TensorCounterCollab;

    beforeEach(() => {
      aliceCounter = alice.registerCollab(
        "counterId",
        (init) => new TensorCounterCollab(init, shape, "float32")
      );
      bobCounter = bob.registerCollab(
        "counterId",
        (init) => new TensorCounterCollab(init, shape, "float32")
      );
    });

    it("is initially all zero", () => {
      assertTensorsStrictEqual(aliceCounter.value, 0);
      assertTensorsStrictEqual(bobCounter.value, 0);
    });

    describe("add", () => {
      it("works for non-concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(-1);
        const tensor2 = tf.zeros(shape).add(1);
        const tensor3 = tf.randomNormal(shape);

        aliceCounter.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsApproxEqual(aliceCounter.value, tensor1);
        assertTensorsApproxEqual(bobCounter.value, tensor1);

        bobCounter.add(tensor2);
        const expected1 = tensor1.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsApproxEqual(aliceCounter.value, expected1);
        assertTensorsApproxEqual(bobCounter.value, expected1);

        aliceCounter.add(tensor3);
        const expected2 = expected1.add(tensor3);
        runtimeGen.releaseAll();
        assertTensorsApproxEqual(aliceCounter.value, expected2);
        assertTensorsApproxEqual(bobCounter.value, expected2);
      });

      it("works for concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(2);
        const tensor2 = tf.zeros(shape).add(-1);
        const sum = tensor1.add(tensor2);

        aliceCounter.add(tensor1);
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, 0);

        bobCounter.add(tensor2);
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor2);

        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, sum);
        assertTensorsStrictEqual(bobCounter.value, sum);
      });
    });

    describe("reset", () => {
      it("works for non-concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(-5);
        const tensor2 = tf.zeros(shape).add(10);

        bobCounter.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        aliceCounter.reset();
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, 0);
        assertTensorsStrictEqual(bobCounter.value, 0);

        bobCounter.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor2);
        assertTensorsStrictEqual(bobCounter.value, tensor2);
      });

      it("works for non-concurrent reset followed by add", () => {
        const tensor1 = tf.zeros(shape).add(324);
        const tensor2 = tf.zeros(shape).add(-213);

        aliceCounter.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor1);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        aliceCounter.reset();
        assertTensorsStrictEqual(aliceCounter.value, 0);
        assertTensorsStrictEqual(bobCounter.value, tensor1);

        aliceCounter.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor2);
        assertTensorsStrictEqual(bobCounter.value, tensor2);
      });

      it("lets concurrent adds survive", () => {
        const tensor = tf.zeros(shape).add(10);

        aliceCounter.add(tensor);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor);
        assertTensorsStrictEqual(bobCounter.value, tensor);

        aliceCounter.reset();
        bobCounter.add(tensor);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceCounter.value, tensor);
        assertTensorsStrictEqual(bobCounter.value, tensor);
      });
    });
  });

  describe("TensorAverage", function () {
    this.slow(1000); // tensor operations on large tensors can be slow
    const shape = [100, 100];
    let aliceAvg: TensorAverageCollab;
    let bobAvg: TensorAverageCollab;

    beforeEach(() => {
      aliceAvg = alice.registerCollab(
        "avgId",
        (init) => new TensorAverageCollab(init, shape, "float32")
      );
      bobAvg = bob.registerCollab(
        "avgId",
        (init) => new TensorAverageCollab(init, shape, "float32")
      );
    });

    it("initially returns a tensor containing NaN", () => {
      assertTensorIsNaN(aliceAvg.value);
      assertTensorIsNaN(bobAvg.value);
    });

    describe("add", () => {
      it("works for non-concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(-1);
        const tensor2 = tf.zeros(shape).add(1);
        const tensor3 = tf.randomNormal(shape);

        aliceAvg.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsApproxEqual(aliceAvg.value, tensor1);
        assertTensorsApproxEqual(bobAvg.value, tensor1);

        bobAvg.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsApproxEqual(aliceAvg.value, 0);
        assertTensorsApproxEqual(bobAvg.value, 0);

        aliceAvg.add(tensor3);
        const expected = tensor1.add(tensor2).add(tensor3).div(3);
        runtimeGen.releaseAll();
        assertTensorsApproxEqual(aliceAvg.value, expected);
        assertTensorsApproxEqual(bobAvg.value, expected);
      });

      it("works for concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(3);
        const tensor2 = tf.zeros(shape).add(-1);

        aliceAvg.add(tensor1);
        assertTensorsStrictEqual(aliceAvg.value, tensor1);
        assertTensorIsNaN(bobAvg.value);

        bobAvg.add(tensor2);
        assertTensorsStrictEqual(aliceAvg.value, tensor1);
        assertTensorsStrictEqual(bobAvg.value, tensor2);

        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, 1);
        assertTensorsStrictEqual(bobAvg.value, 1);
      });
    });

    describe("reset", () => {
      it("works for non-concurrent updates", () => {
        const tensor1 = tf.zeros(shape).add(-5);
        const tensor2 = tf.zeros(shape).add(10);

        bobAvg.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, tensor1);
        assertTensorsStrictEqual(bobAvg.value, tensor1);

        aliceAvg.reset();
        runtimeGen.releaseAll();
        assertTensorIsNaN(aliceAvg.value);
        assertTensorIsNaN(bobAvg.value);

        bobAvg.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, tensor2);
        assertTensorsStrictEqual(bobAvg.value, tensor2);
      });

      it("works for non-concurrent reset followed by add", () => {
        const tensor1 = tf.zeros(shape).add(324);
        const tensor2 = tf.zeros(shape).add(-213);

        aliceAvg.add(tensor1);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, tensor1);
        assertTensorsStrictEqual(bobAvg.value, tensor1);

        aliceAvg.reset();
        assertTensorIsNaN(aliceAvg.value);
        assertTensorsStrictEqual(bobAvg.value, tensor1);

        aliceAvg.add(tensor2);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, tensor2);
        assertTensorsStrictEqual(bobAvg.value, tensor2);
      });

      it("lets concurrent adds survive", () => {
        const tensor = tf.zeros(shape).add(10);

        aliceAvg.add(tensor);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, tensor);
        assertTensorsStrictEqual(bobAvg.value, tensor);

        aliceAvg.reset();
        bobAvg.add(tensor);
        runtimeGen.releaseAll();
        assertTensorsStrictEqual(aliceAvg.value, tensor);
        assertTensorsStrictEqual(bobAvg.value, tensor);
      });
    });
  });
});
