import * as crdts from "compoventuals";
import { ContainerRuntimeSource } from "compoventuals-container";
import Quill, { DeltaOperation } from "quill";

// Include CSS
require("quill/dist/quill.snow.css");

const Delta = Quill.import("delta");
declare type Delta = {
  ops: DeltaOperation[];
};

interface RichCharEventsRecord extends crdts.CrdtEventsRecord {
  Format: { key: string } & crdts.CrdtEvent;
}

class RichChar extends crdts.CObject<RichCharEventsRecord> {
  private readonly attributes: crdts.LwwCMap<string, any>;

  /**
   * char comes from a Quill Delta's insert field, split
   * into single characters if a string.  So it is either
   * a single char, or (for an embed) a JSON-serializable
   * object with a single property.
   */
  constructor(initToken: crdts.CrdtInitToken, readonly char: string | object) {
    super(initToken);

    this.attributes = this.addChild("", crdts.Pre(crdts.LwwCMap)());

    // Events
    this.attributes.on("Set", (e) => {
      this.emit("Format", {
        key: e.key,
        meta: e.meta,
      });
    });
    this.attributes.on("Delete", (e) => {
      this.emit("Format", { key: e.key, meta: e.meta });
    });
  }

  getAttribute(attribute: string): any | null {
    return this.attributes.get(attribute) ?? null;
  }

  /**
   * null attribute deletes the existing one.
   */
  setAttribute(attribute: string, value: any | null) {
    if (value === null) {
      this.attributes.delete(attribute);
    } else {
      this.attributes.set(attribute, value);
    }
  }
}

interface RichTextEventsRecord extends crdts.CrdtEventsRecord {
  Insert: { startIndex: number; count: number } & crdts.CrdtEvent;
  Delete: { startIndex: number; count: number } & crdts.CrdtEvent;
  Format: { index: number; key: string } & crdts.CrdtEvent;
}

class RichText extends crdts.CObject<RichTextEventsRecord> {
  readonly text: crdts.DeletingMutCList<RichChar, [char: string | object]>;

  constructor(
    initToken: crdts.CrdtInitToken,
    initialChars: (string | object)[] = []
  ) {
    super(initToken);

    this.text = this.addChild(
      "",
      crdts.Pre(crdts.DeletingMutCList)(
        (valueInitToken, char) => {
          const richChar = new RichChar(valueInitToken, char);
          richChar.on("Format", (e) => {
            this.emit("Format", { index: this.text.indexOf(richChar), ...e });
          });
          return richChar;
        },
        initialChars.map((value) => [value])
      )
    );
    this.text.on("Insert", (e) => {
      this.emit("Insert", e);
    });
    this.text.on("Delete", (e) => this.emit("Delete", e));
  }

  get(index: number): RichChar {
    return this.text.get(index);
  }

  get length(): number {
    return this.text.length;
  }

  insert(
    index: number,
    char: string | object,
    attributes?: Record<string, any>
  ) {
    const richChar = this.text.insert(index, char);
    this.formatChar(richChar, attributes);
  }

  delete(startIndex: number, count: number) {
    this.text.delete(startIndex, count);
  }

  /**
   * null attribute deletes the existing one.
   */
  format(index: number, newAttributes?: Record<string, any>) {
    this.formatChar(this.get(index), newAttributes);
  }

  private formatChar(richChar: RichChar, newAttributes?: Record<string, any>) {
    if (newAttributes) {
      for (const entry of Object.entries(newAttributes)) {
        richChar.setAttribute(...entry);
      }
    }
  }
}

(async function () {
  const runtime = await ContainerRuntimeSource.newRuntime(
    window.parent,
    new crdts.RateLimitBatchingStrategy(200)
  );

  // Quill's initial content is "\n".
  const clientText = runtime.registerCrdt("text", crdts.Pre(RichText)(["\n"]));

  const quill = new Quill("#editor", {
    theme: "snow",
    // Modules list from quilljs example, via
    // https://github.com/KillerCodeMonkey/ngx-quill/issues/295#issuecomment-443268064
    // We remove syntax: true because I can't figure out how
    // to trick Webpack into importing highlight.js for
    // side-effects.
    // Same with "formula" (after "video") and katex.
    modules: {
      toolbar: [
        [{ font: [] }, { size: [] }],
        ["bold", "italic", "underline", "strike"],
        [{ color: [] }, { background: [] }],
        [{ script: "super" }, { script: "sub" }],
        [{ header: "1" }, { header: "2" }, "blockquote", "code-block"],
        [
          { list: "ordered" },
          { list: "bullet" },
          { indent: "-1" },
          { indent: "+1" },
        ],
        ["direction", { align: [] }],
        ["link", "image", "video"],
        ["clean"],
      ],
    },
  });

  /**
   * Convert delta.ops into an array of modified DeltaOperations
   * having the form { index: first char index, ...DeltaOperation},
   * leaving out ops that do nothing.
   */
  function getRelevantDeltaOperations(delta: Delta): {
    index: number;
    insert?: string | object;
    delete?: number;
    attributes?: Record<string, any>;
    retain?: number;
  }[] {
    const relevantOps = [];
    let index = 0;
    for (const op of delta.ops) {
      if (op.retain === undefined || op.attributes) {
        relevantOps.push({ index, ...op });
      }
      // Adjust index for the next op.
      if (op.insert !== undefined) {
        if (typeof op.insert === "string") index += op.insert.length;
        else index += 1; // Embed
      } else if (op.retain !== undefined) index += op.retain;
      // Deletes don't add to the index because we'll do the
      // next operation after them, hence the text will already
      // be shifted left.
    }
    return relevantOps;
  }

  // Convert user inputs to Crdt operations.
  quill.on("text-change", (delta) => {
    // In theory we can listen for events with source "user",
    // to ignore changes caused by Crdt events instead of
    // user input.  However, changes that remove formatting
    // using the "remove formatting" button, or by toggling
    // a link off, instead get emitted with source "api".
    // This appears to be fixed only on a not-yet-released v2
    // branch: https://github.com/quilljs/quill/issues/739
    // For now, we manually keep track of whether changes are due
    // to us or not.
    // if (source !== "user") return;
    if (ourChange) return;

    for (const op of getRelevantDeltaOperations(delta)) {
      // Insertion
      if (op.insert) {
        if (typeof op.insert === "string") {
          for (let i = 0; i < op.insert.length; i++) {
            clientText.insert(op.index + i, op.insert[i], op.attributes);
          }
        } else {
          // Embed of object
          clientText.insert(op.index, op.insert, op.attributes);
        }
      }
      // Deletion
      else if (op.delete) {
        clientText.delete(op.index, op.delete);
      }
      // Formatting
      else if (op.attributes && op.retain) {
        for (let i = 0; i < op.retain; i++) {
          clientText.format(op.index + i, op.attributes);
        }
      }
    }
  });

  // Reflect Crdt operations in Quill.
  // Note that for local operations, Quill has already updated
  // its own representation, so we should skip doing so again.

  let ourChange = false;
  function updateContents(delta: Delta) {
    ourChange = true;
    quill.updateContents(delta as any);
    ourChange = false;
  }

  clientText.on("Insert", (e) => {
    if (e.meta.isLocal) return;

    for (let index = e.startIndex; index < e.startIndex + e.count; index++) {
      // Characters start without any formatting.
      updateContents(
        new Delta().retain(index).insert(clientText.get(index).char)
      );
    }
  });

  clientText.on("Delete", (e) => {
    if (e.meta.isLocal) return;

    updateContents(new Delta().retain(e.startIndex).delete(e.count));
  });

  clientText.on("Format", (e) => {
    if (e.meta.isLocal) return;

    updateContents(
      new Delta()
        .retain(e.index)
        .retain(1, { [e.key]: clientText.get(e.index).getAttribute(e.key) })
    );
  });
})();

// TODO: cursor management.  Quill appears to be doing this
// for us, but should verify.