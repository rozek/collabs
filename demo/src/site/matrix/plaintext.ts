import * as crdts from "compoventuals-client";

const client = new crdts.Runtime(
  new crdts.MatrixWidgetNetwork("com.herokuapp.compoventuals-tests.plaintext"),
  { periodMs: 300 }
);

const text = client.registerCrdt("text", new crdts.TextCrdt());

const textarea = document.getElementById("textarea") as HTMLTextAreaElement;
textarea.value = "";

// TODO: shared cursors

const myStartCursor = new crdts.Cursor(text, 0);
const myEndCursor = new crdts.Cursor(text, 0);
function updateSelection() {
  // Need to do this on a delay because the event doesn't
  // due its default action (updating the handler) until
  // after the event handlers.
  setTimeout(() => {
    myStartCursor.index = textarea.selectionStart;
    myEndCursor.index = textarea.selectionEnd;
  }, 0);
}
function updateCursor() {
  textarea.selectionStart = myStartCursor.index;
  textarea.selectionEnd = myEndCursor.index;
}

window.addEventListener("selectionchange", updateSelection);
textarea.addEventListener("mousedown", updateSelection);
textarea.addEventListener("mousemove", (e) => {
  if (e.buttons === 1) updateSelection();
});
textarea.addEventListener("mouseclick", updateSelection);

// Change the text when a key is pressed in textarea
textarea.addEventListener("keydown", (e) => {
  const startIndex = myStartCursor.index;
  const endIndex = myEndCursor.index;
  if (e.key === "Backspace") {
    if (endIndex > startIndex) {
      text.deleteAtRange(startIndex, endIndex);
      myEndCursor.index = startIndex;
    } else if (endIndex === startIndex && startIndex > 0) {
      text.deleteAt(startIndex - 1);
      myStartCursor.index = startIndex - 1;
    }
  } else if (e.key === "Delete") {
    if (endIndex > startIndex) {
      text.deleteAtRange(startIndex, endIndex);
      myEndCursor.index = startIndex;
    } else if (endIndex === startIndex && startIndex < textarea.value.length) {
      text.deleteAt(startIndex);
    }
  } else if (e.key === "Enter") {
    type("\n", startIndex, endIndex);
  } else if (e.key === "Tab") {
    // TODO: proper tab behavior
    type("    ", startIndex, endIndex);
  } else if (shouldType(e)) {
    type(e.key, startIndex, endIndex);
  } else {
    // Assume it's either irrelevant or selection related
    updateSelection();
    return; // Don't updateCursor or preventDefault.
    // Ctrl+V, Ctrl+X dispatch paste/cut events, like when
    // using the mouse menu versions, which we handle below.
    // Ctrl+C doesn't need to be handled (default works fine.)
    // So we don't need cases for these.
  }

  updateCursor();
  // Don't let the browser type the key, we do it for them
  e.preventDefault();
});

function type(str: string, startIndex: number, endIndex: number) {
  if (startIndex < endIndex) {
    // Delete current selection
    text.deleteAtRange(startIndex, endIndex);
  }
  text.insertAtRange(startIndex, [...str]);
  myStartCursor.index = startIndex + str.length;
  myEndCursor.index = startIndex + str.length;
}

function shouldType(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

textarea.addEventListener("paste", (e) => {
  if (e.clipboardData) {
    const pasted = e.clipboardData.getData("text");
    type(pasted, myStartCursor.index, myEndCursor.index);
    updateCursor();
  }
  e.preventDefault();
});

textarea.addEventListener("cut", () => {
  const startIndex = myStartCursor.index;
  const endIndex = myEndCursor.index;
  if (startIndex < endIndex) {
    const selected = textarea.value.slice(startIndex, endIndex);
    navigator.clipboard.writeText(selected);
    text.deleteAtRange(startIndex, endIndex);
  }
});

// TODO: allow drag+drop text?  Currently we just
// disable it.
textarea.addEventListener("dragstart", (e) => {
  e.preventDefault();
});
textarea.addEventListener("drop", (e) => {
  e.preventDefault();
});

// Display text changes
text.on("Change", () => {
  textarea.value = text.asArray().join("");
  updateCursor();
});
