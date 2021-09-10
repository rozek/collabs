import { BatchingStrategy, BroadcastNetwork, Runtime } from "compoventuals";

class ContainerNetwork implements BroadcastNetwork {
  constructor(private readonly messagePort: MessagePort) {}

  onreceive!: (message: Uint8Array) => void;

  send(message: Uint8Array): void {
    this.messagePort.postMessage({ type: "send", message });
  }

  save(): Uint8Array {
    return new Uint8Array(0);
  }

  load(_saveData: Uint8Array): void {}
}

export class ContainerRuntimeSource {
  /**
   * Not instantiable.
   */
  private constructor() {}

  /**
   * TODO: caveat: won't return until after the window
   * is loaded.  So don't use window.onload after awaiting
   * this (it will never be triggered).
   * @param  hostWindow   [description]
   * @param  batchOptions [description]
   * @return              [description]
   */
  static async newRuntime(
    hostWindow: Window,
    batchingStrategy?: BatchingStrategy
  ): Promise<Runtime> {
    const messagePort = await new Promise<MessagePort>((resolve) => {
      window.addEventListener("message", (e) => {
        if (e.source !== hostWindow) return;
        // TODO: other checks?
        resolve(e.ports[0]);
        // TODO: remove listener?
      });
    });
    const network = new ContainerNetwork(messagePort);
    const runtime = new Runtime(network, batchingStrategy);
    messagePort.onmessage = (e) => {
      switch (e.data.type) {
        case "receive":
          network.onreceive(e.data.message);
          break;
        case "load":
          runtime.load(e.data.saveData);
          messagePort.postMessage({ type: "loadComplete" });
          break;
        default:
          throw new Error("bad e.data.type: " + e.data.type);
      }
    };
    return runtime;
  }
}